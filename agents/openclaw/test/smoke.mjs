// Wire-level smoke test for the Synadia Agent Protocol for NATS v0.3 layer of
// @synadia-ai/nats-channel (OpenClaw).
//
// This test does NOT boot a full OpenClaw pipeline. Instead it assembles a
// minimal spec-compliant service from the same primitives gateway.ts uses
// (`agents` micro service + prompt endpoint + heartbeat + typed chunks)
// and drives it against a real nats-server. That verifies the parts of the
// protocol layer that live in this repo (protocol.ts + attachments.ts) end
// to end.
//
// Full-pipeline verification (envelope → OpenClaw dispatch → response
// streaming) runs inside a real OpenClaw install.
//
//   bun test/smoke.mjs
//
// Server: this test always spawns its own private nats-server (via
// `test/nats-server.conf`, which pins `port: -1` so the kernel picks an
// ephemeral port and `max_payload: 8MB` so the dynamic max_payload path is
// exercised). The chosen port is read back from `--ports_file_dir` and the
// server is killed on exit. Prereq: `nats-server` on PATH.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import { createInbox } from "@nats-io/nats-core";
import { Svcm } from "@nats-io/services";

import {
	AgentSubject,
	PROMPT_QUEUE_GROUP,
	ProtocolError,
	SDK_PROTOCOL_VERSION,
	SERVICE_NAME,
	decodeEnvelope,
	formatHumanBytes,
} from "@synadia-ai/agents";
import {
	DEFAULT_ATTACHMENTS_OK,
	DEFAULT_HEARTBEAT_INTERVAL_S,
	DEFAULT_MAX_PAYLOAD,
	buildHeartbeatPayload,
	encodeChunk,
	encodeHeartbeatPayload,
} from "@synadia-ai/agent-service";
import {
	AGENT_ID,
	DEFAULT_SESSION,
	SERVICE_VERSION,
	SUBJECT_AGENT_TOKEN,
} from "../src/nats/protocol.ts";
import { cleanupAgentStaging, stageAttachmentsIntoPrompt } from "../src/attachments.ts";

const OWNER = "smoke";
const AGENT_NAME = `oc-${process.pid}`;
const STAGE_DIR = join(tmpdir(), `nats-oc-smoke-${process.pid}`);
const subject = AgentSubject.new(AGENT_ID, OWNER, AGENT_NAME, {
	subjectToken: SUBJECT_AGENT_TOKEN,
});
const SUBJECT = subject.prompt;
const HB_SUBJECT = subject.heartbeat;

let ok = 0;
let fail = 0;
function step(name, fn) {
	return async () => {
		try {
			await fn();
			console.log(`  ✓ ${name}`);
			ok++;
		} catch (e) {
			console.error(`  ✗ ${name}\n      ${e.message}`);
			fail++;
		}
	};
}

// ── Spawn a private nats-server on an ephemeral port ──────────────────────
// Avoids touching whatever the developer has running on 4222 — every smoke
// run is fully isolated.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTS_DIR = mkdtempSync(join(tmpdir(), "nats-oc-smoke-ports-"));
const NATS_CONF = join(__dirname, "nats-server.conf");
const spawnedServer = spawn(
	"nats-server",
	["-c", NATS_CONF, "--ports_file_dir", PORTS_DIR],
	{ stdio: "ignore" },
);
spawnedServer.on("error", (err) => {
	console.error(`could not spawn nats-server: ${err.message}`);
	console.error("install nats-server (https://nats.io) before re-running this smoke");
	process.exit(2);
});
process.on("exit", () => {
	if (spawnedServer && !spawnedServer.killed) spawnedServer.kill();
	try {
		rmSync(PORTS_DIR, { recursive: true, force: true });
	} catch {}
});

// `nats-server --ports_file_dir <dir>` writes `<exe>_<pid>.ports` once it
// finishes binding — poll for it.
async function readBoundUrl() {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			const entries = readdirSync(PORTS_DIR).filter((f) => f.endsWith(".ports"));
			if (entries.length > 0) {
				const ports = JSON.parse(readFileSync(join(PORTS_DIR, entries[0]), "utf8"));
				if (Array.isArray(ports.nats) && ports.nats.length > 0) return ports.nats[0];
			}
		} catch {}
		await delay(50);
	}
	throw new Error("nats-server never wrote a ports file");
}
const SERVER_URL = await readBoundUrl();
console.log(`  (spawned nats-server at ${SERVER_URL})`);

// ── Observer connection (subscribes BEFORE service registers) ──────────────
const obs = await connect({ servers: SERVER_URL });
// v0.3 heartbeat wildcard: `agents.hb.<agent>.<owner>.<name>`.
const hbSub = obs.subscribe("agents.hb.*.*.*");
const heartbeats = [];
(async () => {
	for await (const m of hbSub) {
		try {
			heartbeats.push(JSON.parse(new TextDecoder().decode(m.data)));
		} catch {}
	}
})();

// ── Gateway connection + minimal service ───────────────────────────────────
const gw = await connect({ servers: SERVER_URL });
// Match the gateway: derive the advertised max_payload from `nc.info`.
const maxPayloadStr = gw.info?.max_payload ? formatHumanBytes(gw.info.max_payload) : DEFAULT_MAX_PAYLOAD;
const svc = await new Svcm(gw).add({
	name: SERVICE_NAME,
	version: SERVICE_VERSION,
	description: `OpenClaw smoke agent ${AGENT_NAME}`,
	metadata: {
		agent: AGENT_ID,
		owner: OWNER,
		session: DEFAULT_SESSION,
		protocol_version: `${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`,
		platform: "openclaw",
	},
});
const instanceId = svc.info().id;

// Minimal spec-compliant prompt handler. Mirrors gateway.ts's handler in the
// parts that don't involve the OpenClaw pipeline.
let lastAcceptedPrompt = null;
svc.addEndpoint("prompt", {
	subject: SUBJECT,
	queue: PROMPT_QUEUE_GROUP,
	metadata: {
		max_payload: maxPayloadStr,
		attachments_ok: DEFAULT_ATTACHMENTS_OK ? "true" : "false",
	},
	handler: (err, msg) => {
		if (err || !msg.reply) return;
		let envelope;
		try {
			envelope = decodeEnvelope(msg.data);
		} catch (e) {
			const code = e instanceof ProtocolError ? 400 : 500;
			msg.respondError(code, e.message);
			gw.publish(msg.reply, "");
			return;
		}
		let finalPrompt;
		try {
			finalPrompt = stageAttachmentsIntoPrompt({
				baseDir: STAGE_DIR,
				agentName: AGENT_NAME,
				prompt: envelope.prompt,
				attachments: (envelope.attachments ?? []).map((a) => ({
					filename: a.filename,
					bytes: a.content,
				})),
			});
		} catch (e) {
			msg.respondError(500, `staging failed: ${e.message}`);
			gw.publish(msg.reply, "");
			return;
		}
		lastAcceptedPrompt = finalPrompt;
		// ack → response → terminator
		gw.publish(msg.reply, encodeChunk({ type: "status", status: "ack" }));
		gw.publish(msg.reply, encodeChunk({ type: "response", text: "ok" }));
		gw.publish(msg.reply, "");
	},
});

// Heartbeat loop
const hbTimer = setInterval(() => {
	gw.publish(
		HB_SUBJECT,
		encodeHeartbeatPayload(
			buildHeartbeatPayload(subject, DEFAULT_HEARTBEAT_INTERVAL_S, instanceId, {
				session: DEFAULT_SESSION,
			}),
		),
	);
}, DEFAULT_HEARTBEAT_INTERVAL_S * 1000);
hbTimer.unref?.();
// One immediate beat so smoke test doesn't wait a full cadence.
gw.publish(
	HB_SUBJECT,
	encodeHeartbeatPayload(
		buildHeartbeatPayload(subject, DEFAULT_HEARTBEAT_INTERVAL_S, instanceId, {
			session: DEFAULT_SESSION,
		}),
	),
);

await delay(300);

// ── Helpers ────────────────────────────────────────────────────────────────
async function collectStream(payload) {
	const inbox = createInbox();
	const sub = obs.subscribe(inbox);
	const chunks = [];
	let error = null;
	let terminator = false;
	const done = (async () => {
		for await (const m of sub) {
			const hasHeaders = m.headers && [...m.headers].length > 0;
			const code = m.headers?.get("Nats-Service-Error-Code");
			if (code) {
				error = { code: Number(code), description: m.headers?.get("Nats-Service-Error") ?? "" };
				continue;
			}
			if (m.data.byteLength === 0 && !hasHeaders) {
				terminator = true;
				sub.unsubscribe();
				return;
			}
			try {
				chunks.push(JSON.parse(new TextDecoder().decode(m.data)));
			} catch {
				chunks.push({ raw: new TextDecoder().decode(m.data) });
			}
		}
	})();
	obs.publish(SUBJECT, payload, { reply: inbox });
	await Promise.race([done, delay(2000)]);
	sub.unsubscribe();
	return { chunks, error, terminator };
}

// ── Tests ──────────────────────────────────────────────────────────────────

await step("$SRV.INFO.agents returns spec-shaped metadata + prompt endpoint", async () => {
	const client = new Svcm(obs).client({ strategy: "stall", maxWait: 1000, maxMessages: 20 });
	const iter = await client.info("agents");
	const infos = [];
	for await (const si of iter) infos.push(si);
	const mine = infos.find((si) => si.id === instanceId);
	assert.ok(mine, "our instance not found");
	assert.equal(mine.metadata.agent, "openclaw");
	assert.equal(mine.metadata.owner, OWNER);
	assert.equal(mine.metadata.session, "default");
	assert.equal(mine.metadata.protocol_version, "0.3");
	const ep = mine.endpoints?.find((e) => e.name === "prompt");
	assert.ok(ep, "prompt endpoint missing");
	assert.equal(ep.subject, SUBJECT);
	assert.equal(ep.queue_group, "agents", "prompt endpoint must register queue_group=agents (spec §3.3)");
	// max_payload is server-driven (`nc.info.max_payload`), so just verify it
	// matches the §2.1 grammar and the value we registered with.
	assert.match(ep.metadata?.max_payload ?? "", /^\d+(B|KB|MB|GB)$/);
	assert.equal(ep.metadata?.max_payload, maxPayloadStr);
	assert.equal(ep.metadata?.attachments_ok, "true");
})();

await step("heartbeat carries all §8.3 required fields", async () => {
	const mine = heartbeats.find((hb) => hb.instance_id === instanceId);
	assert.ok(mine, "no matching heartbeat");
	assert.equal(mine.agent, "openclaw");
	assert.equal(mine.owner, OWNER);
	assert.equal(mine.session, "default");
	assert.equal(mine.interval_s, 30);
	assert.match(mine.ts, /Z$/);
})();

await step("empty payload → 400 + terminator", async () => {
	const { error, terminator, chunks } = await collectStream("");
	assert.ok(error);
	assert.equal(error.code, 400);
	assert.ok(terminator);
	assert.equal(chunks.length, 0);
})();

await step("malformed JSON → 400 + terminator", async () => {
	const { error, terminator } = await collectStream("{not json");
	assert.equal(error?.code, 400);
	assert.ok(terminator);
})();

await step("URL-safe base64 in attachment → 400", async () => {
	const env = JSON.stringify({
		prompt: "hi",
		attachments: [{ filename: "x.txt", content: "aGVsbG8-_w==" }],
	});
	const { error } = await collectStream(env);
	assert.equal(error?.code, 400);
})();

await step("path-traversal filename → 400", async () => {
	const env = JSON.stringify({
		prompt: "hi",
		attachments: [{ filename: "../../etc/passwd", content: "aGVsbG8=" }],
	});
	const { error } = await collectStream(env);
	assert.equal(error?.code, 400);
})();

await step("plain-text prompt → ack → response → empty terminator (no headers)", async () => {
	const { chunks, error, terminator } = await collectStream("Hello");
	assert.ok(!error, `unexpected error ${JSON.stringify(error)}`);
	assert.ok(terminator, "no terminator observed");
	assert.deepEqual(
		{ type: chunks[0]?.type, data: chunks[0]?.data },
		{ type: "status", data: "ack" },
	);
	const responseChunk = chunks.find((c) => c.type === "response");
	assert.ok(responseChunk);
	assert.equal(responseChunk.data, "ok");
	assert.equal(lastAcceptedPrompt, "Hello");
})();

await step("valid attachment → file on disk, prompt augmented, ok response", async () => {
	const payloadBytes = new TextEncoder().encode("attachment body");
	const content = Buffer.from(payloadBytes).toString("base64");
	const env = JSON.stringify({
		prompt: "describe",
		attachments: [{ filename: "note.txt", content }],
	});
	const { error, terminator } = await collectStream(env);
	assert.ok(!error);
	assert.ok(terminator);
	assert.ok(lastAcceptedPrompt.startsWith("[Attachments available at the following absolute paths]\n"));
	const pathMatch = lastAcceptedPrompt.match(/^- (\S.*)$/m);
	assert.ok(pathMatch, "no path line in augmented prompt");
	const stagedPath = pathMatch[1];
	assert.ok(existsSync(stagedPath), `staged file missing at ${stagedPath}`);
	assert.deepEqual(new Uint8Array(readFileSync(stagedPath)), payloadBytes);
	assert.ok(stagedPath.endsWith("/note.txt"));
	assert.ok(stagedPath.startsWith(join(STAGE_DIR, AGENT_NAME) + "/"), "staged outside agent dir");
})();

await step("cleanupAgentStaging removes the staging tree", async () => {
	cleanupAgentStaging(STAGE_DIR, AGENT_NAME);
	assert.equal(existsSync(join(STAGE_DIR, AGENT_NAME)), false);
})();

// ── Teardown ───────────────────────────────────────────────────────────────
clearInterval(hbTimer);
await svc.stop();
await gw.drain();
hbSub.unsubscribe();
await obs.drain();
try {
	rmSync(STAGE_DIR, { recursive: true, force: true });
} catch {}

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

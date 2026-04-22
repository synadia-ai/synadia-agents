// Spec-compliance smoke test for extensions/nats-channel.ts.
//
// Drives the extension with a minimal mock of PI's ExtensionAPI, connects
// to a local nats-server, and asserts protocol 0.1 behaviour:
//
//   1. Service registers under `agents` with spec metadata.
//   2. The `prompt` endpoint has `max_payload` / `attachments_ok` metadata.
//   3. Heartbeats arrive on `agents.pi.{owner}.{name}.heartbeat`.
//   4. Empty payload → 400 + terminator.
//   5. Plain-text prompt yields a `status: ack` chunk, text chunks via the
//      mock emitter, and an empty-body no-headers terminator.
//   6. Request with attachments → 400 + terminator.
//
// Run with:
//   bun test/smoke.mjs
// Prereq: nats-server on 127.0.0.1:4222.
//
// Exit code is non-zero on any failed assertion.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "@nats-io/transport-node";
import { createInbox } from "@nats-io/nats-core";
import { Svcm } from "@nats-io/services";

import channelFactory from "../extensions/nats-channel.ts";

process.env.NATS_CONTEXT = "localhost";
process.env.NATS_SESSION_NAME = `smoke-${process.pid}`;
process.env.USER = process.env.USER || "smoke";

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

// ── Mock ExtensionAPI ──────────────────────────────────────────────────────
const listeners = new Map();
let pendingSendUserMessage = null;
const mockCtx = {
	cwd: process.cwd(),
	isIdle: () => true,
	ui: {
		notify: (line, _level) => console.log(`    [notify] ${line}`),
		setStatus: (_key, _val) => {},
	},
};
const mockPi = {
	on(event, cb) {
		if (!listeners.has(event)) listeners.set(event, []);
		listeners.get(event).push(cb);
	},
	sendUserMessage(text) {
		pendingSendUserMessage = text;
	},
	registerCommand(_name, _spec) {},
};

function emit(event, ...args) {
	const cbs = listeners.get(event) ?? [];
	return Promise.all(cbs.map((cb) => cb(...args, mockCtx)));
}

// ── Observer NATS connection (separate from the one the extension opens) ──
const obs = await connect({ servers: "nats://127.0.0.1:4222" });

// Subscribe to heartbeats BEFORE the extension registers — §8.5.
const hbSub = obs.subscribe("agents.*.*.*.heartbeat");
const heartbeats = [];
(async () => {
	for await (const m of hbSub) {
		try {
			heartbeats.push(JSON.parse(new TextDecoder().decode(m.data)));
		} catch {}
	}
})();

// ── Boot the extension ────────────────────────────────────────────────────
channelFactory(mockPi);
await emit("session_start", {});

// Let registration + first heartbeat settle.
await delay(500);

const owner = (process.env.USER ?? "smoke")
	.replace(/[^a-zA-Z0-9_-]/g, "-")
	.toLowerCase()
	.replace(/^-+|-+$/g, "");
const session = process.env.NATS_SESSION_NAME;
const expectedSubject = `agents.pi.${owner}.${session}`;

// ── Tests ──────────────────────────────────────────────────────────────────

await step("$SRV.INFO returns spec-shaped service info", async () => {
	const svcm = new Svcm(obs);
	const client = svcm.client({ strategy: "stall", maxWait: 1000, maxMessages: 20 });
	const iter = await client.info("agents");
	const infos = [];
	for await (const si of iter) infos.push(si);
	const mine = infos.find(
		(si) => si.metadata?.agent === "pi" && si.metadata?.session === session,
	);
	assert.ok(mine, `no agents-service instance with session=${session} found`);
	assert.equal(mine.metadata.agent, "pi");
	assert.equal(mine.metadata.owner, owner);
	assert.equal(mine.metadata.protocol_version, "0.2");
	assert.ok(mine.metadata.session.length > 0);

	const ep = mine.endpoints?.find((e) => e.name === "prompt");
	assert.ok(ep, "prompt endpoint missing");
	assert.equal(ep.subject, expectedSubject);
	assert.equal(ep.queue_group, "agents", "prompt endpoint must register queue_group=agents (spec §3.3)");
	assert.equal(ep.metadata?.max_payload, "1MB");
	assert.equal(ep.metadata?.attachments_ok, "true");
})();

await step("heartbeat published on agents.pi.{owner}.{session}.heartbeat", async () => {
	const mine = heartbeats.find(
		(hb) => hb.agent === "pi" && hb.session === session && hb.owner === owner,
	);
	assert.ok(mine, "no matching heartbeat received");
	assert.equal(typeof mine.instance_id, "string");
	assert.equal(typeof mine.ts, "string");
	assert.equal(mine.interval_s, 30);
})();

// Helper — consume a stream until terminator, capturing chunks + error.
async function collectStream(requestSubject, payload) {
	const inbox = createInbox();
	const sub = obs.subscribe(inbox);
	const chunks = [];
	let error = null;
	let terminator = null;
	const done = (async () => {
		for await (const msg of sub) {
			const code = msg.headers?.get("Nats-Service-Error-Code");
			const hasHeaders = msg.headers && [...msg.headers].length > 0;
			if (code) {
				error = {
					code: Number(code),
					description: msg.headers?.get("Nats-Service-Error") ?? "",
				};
				continue;
			}
			if (msg.data.byteLength === 0 && !hasHeaders) {
				terminator = { hasHeaders: false };
				sub.unsubscribe();
				return;
			}
			chunks.push(new TextDecoder().decode(msg.data));
		}
	})();
	obs.publish(requestSubject, payload, { reply: inbox });
	await Promise.race([done, delay(3000)]);
	sub.unsubscribe();
	return { chunks, error, terminator };
}

await step("empty payload → 400 + terminator", async () => {
	const { chunks, error, terminator } = await collectStream(expectedSubject, "");
	assert.ok(error, "expected error response");
	assert.equal(error.code, 400);
	assert.ok(terminator, "expected empty terminator after error");
	assert.equal(chunks.length, 0);
})();

await step("invalid base64 in attachment → 400", async () => {
	// Contains non-base64 characters.
	const env = JSON.stringify({
		prompt: "hi",
		attachments: [{ filename: "x.txt", content: "not base64!!" }],
	});
	const { error } = await collectStream(expectedSubject, env);
	assert.ok(error);
	assert.equal(error.code, 400);
})();

await step("URL-safe base64 in attachment → 400 (strict RFC 4648 §4)", async () => {
	// `-` and `_` are URL-safe alphabet, forbidden by spec §5.2.
	const env = JSON.stringify({
		prompt: "hi",
		attachments: [{ filename: "x.txt", content: "aGVsbG8-_w==" }],
	});
	const { error } = await collectStream(expectedSubject, env);
	assert.ok(error);
	assert.equal(error.code, 400);
})();

await step("path-traversal filename → 400", async () => {
	const env = JSON.stringify({
		prompt: "hi",
		attachments: [{ filename: "../../etc/passwd", content: "aGVsbG8=" }],
	});
	const { error } = await collectStream(expectedSubject, env);
	assert.ok(error);
	assert.equal(error.code, 400);
})();

await step("absolute-path filename → 400", async () => {
	const env = JSON.stringify({
		prompt: "hi",
		attachments: [{ filename: "/etc/passwd", content: "aGVsbG8=" }],
	});
	const { error } = await collectStream(expectedSubject, env);
	assert.ok(error);
	assert.equal(error.code, 400);
})();

await step("malformed JSON → 400 + terminator", async () => {
	const { error, terminator } = await collectStream(expectedSubject, "{not json");
	assert.ok(error);
	assert.equal(error.code, 400);
	assert.ok(terminator);
})();

await step("JSON envelope missing prompt → 400", async () => {
	const { error } = await collectStream(expectedSubject, '{"hello":"world"}');
	assert.ok(error);
	assert.equal(error.code, 400);
})();

await step("plain-text prompt → ack → response chunks → terminator", async () => {
	const env = "Hello, world.";
	pendingSendUserMessage = null;
	const inbox = createInbox();
	const sub = obs.subscribe(inbox);
	const observed = [];
	let terminatorNoHeaders = false;
	const done = (async () => {
		for await (const msg of sub) {
			const code = msg.headers?.get("Nats-Service-Error-Code");
			const hasHeaders = msg.headers && [...msg.headers].length > 0;
			if (code) {
				observed.push({ kind: "error", code: Number(code) });
				continue;
			}
			if (msg.data.byteLength === 0 && !hasHeaders) {
				terminatorNoHeaders = true;
				sub.unsubscribe();
				return;
			}
			const parsed = JSON.parse(new TextDecoder().decode(msg.data));
			observed.push({ kind: "chunk", ...parsed });
		}
	})();
	obs.publish(expectedSubject, env, { reply: inbox });

	// Wait for the extension to inject into our mock PI.
	for (let i = 0; i < 50 && pendingSendUserMessage === null; i++) await delay(20);
	assert.equal(pendingSendUserMessage, env);

	// Simulate PI producing text_delta events, then agent_end.
	await emit("message_update", {
		assistantMessageEvent: { type: "text_delta", delta: "Hi " },
	});
	await emit("message_update", {
		assistantMessageEvent: { type: "text_delta", delta: "there!" },
	});
	await emit("agent_end", {});

	await Promise.race([done, delay(2000)]);
	sub.unsubscribe();

	assert.ok(terminatorNoHeaders, "stream did not end with empty-no-headers terminator");

	// First observed chunk MUST be status:ack per §6.4.
	assert.deepEqual(
		{ type: observed[0]?.type, data: observed[0]?.data },
		{ type: "status", data: "ack" },
	);
	// Subsequent response chunks concatenate to the emitted deltas.
	const text = observed
		.filter((o) => o.kind === "chunk" && o.type === "response")
		.map((o) => o.data)
		.join("");
	assert.equal(text, "Hi there!");
})();

// Track where the agent stages attachments so we can verify cleanup later.
const attachmentsSessionDir = join(homedir(), ".pi", "agent", "attachments", session);
let stagedPathSeen = null;

await step("valid attachment → file on disk, prompt augmented, stream ok", async () => {
	const payloadBytes = Buffer.from("hello attachment", "utf8");
	const content = payloadBytes.toString("base64"); // standard, padded
	const env = JSON.stringify({
		prompt: "describe the file",
		attachments: [{ filename: "hello.txt", content }],
	});
	pendingSendUserMessage = null;

	const inbox = createInbox();
	const sub = obs.subscribe(inbox);
	const observed = [];
	let terminatorNoHeaders = false;
	const done = (async () => {
		for await (const msg of sub) {
			const hasHeaders = msg.headers && [...msg.headers].length > 0;
			if (msg.data.byteLength === 0 && !hasHeaders) {
				terminatorNoHeaders = true;
				sub.unsubscribe();
				return;
			}
			if (hasHeaders) continue;
			observed.push(JSON.parse(new TextDecoder().decode(msg.data)));
		}
	})();
	obs.publish(expectedSubject, env, { reply: inbox });

	for (let i = 0; i < 100 && pendingSendUserMessage === null; i++) await delay(20);
	assert.ok(pendingSendUserMessage, "pi.sendUserMessage was not called");

	// The prompt handed to PI should start with the [Attachments] block and
	// contain the original prompt text.
	assert.match(pendingSendUserMessage, /^\[Attachments available at the following absolute paths\]/);
	assert.ok(
		pendingSendUserMessage.endsWith("describe the file"),
		"original prompt text missing from augmented prompt",
	);

	// Extract the staged path from the augmented prompt and verify the bytes
	// landed correctly on disk.
	const match = pendingSendUserMessage.match(/^- (\S.*)$/m);
	assert.ok(match, "no staged path found in augmented prompt");
	const stagedPath = match[1];
	stagedPathSeen = stagedPath;
	assert.ok(existsSync(stagedPath), `staged file missing at ${stagedPath}`);
	assert.deepEqual(readFileSync(stagedPath), payloadBytes);
	assert.ok(stagedPath.startsWith(attachmentsSessionDir + "/"), "staged path outside session dir");
	assert.ok(stagedPath.endsWith("/hello.txt"), "staged filename mismatched");

	// Drive a trivial response stream so the cycle completes cleanly.
	await emit("message_update", {
		assistantMessageEvent: { type: "text_delta", delta: "ok" },
	});
	await emit("agent_end", {});

	await Promise.race([done, delay(2000)]);
	sub.unsubscribe();
	assert.ok(terminatorNoHeaders, "terminator not observed");
	// First observed JSON chunk should be the ack.
	assert.deepEqual(
		{ type: observed[0]?.type, data: observed[0]?.data },
		{ type: "status", data: "ack" },
	);
})();

// ── Teardown ───────────────────────────────────────────────────────────────
await emit("session_shutdown", {});
await delay(200);
hbSub.unsubscribe();
await obs.drain();

await step("session_shutdown removes the staged attachments directory", async () => {
	assert.ok(stagedPathSeen, "no staged path captured in earlier test");
	assert.equal(
		existsSync(attachmentsSessionDir),
		false,
		`attachments dir ${attachmentsSessionDir} was not cleaned up on session_shutdown`,
	);
})();

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

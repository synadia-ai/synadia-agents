// Hermetic controller/session smoke for identity-free, signed-host, and
// signed-only admission modes. Requires `nats-server` on PATH.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createInbox } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { Agents, resolveNatsConnectionBundle } from "@synadia-ai/agents";

import { Controller } from "../src/controller.ts";
import { ManagedSession } from "../src/managed-session.ts";
import {
  controllerListSubject,
  controllerSpawnSubject,
  controllerStopSubject,
} from "../src/subjects.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OPERATOR_FIXTURE =
  process.env.PI_HEADLESS_IDENTITY_FIXTURE ??
  join(HERE, "../../../test-fixtures/identity/operator");
const ALICE_CREDS = join(OPERATOR_FIXTURE, "alice.creds");
const CAROL_CREDS = join(OPERATOR_FIXTURE, "carol.creds");
const SIGNED = process.env.PI_HEADLESS_SMOKE_SIGNED === "1";
const STRICT = process.env.PI_HEADLESS_SMOKE_STRICT === "1";
const AUTHENTICATED = SIGNED || STRICT;
const PORTS_DIR = mkdtempSync(join(tmpdir(), "pi-headless-smoke-"));
const serverArgs = AUTHENTICATED
  ? [
      "-c",
      join(OPERATOR_FIXTURE, "operator.conf"),
      "-a",
      "127.0.0.1",
      "-p",
      "-1",
      "--ports_file_dir",
      PORTS_DIR,
    ]
  : ["-a", "127.0.0.1", "-p", "-1", "--ports_file_dir", PORTS_DIR];
const server = spawn("nats-server", serverArgs, { stdio: "ignore" });
server.on("error", (error) => {
  process.stderr.write(`could not start nats-server: ${error.message}\n`);
  process.exit(2);
});
process.on("exit", () => {
  if (!server.killed) server.kill();
  try {
    rmSync(PORTS_DIR, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

async function boundUrl() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const file = readdirSync(PORTS_DIR).find((entry) =>
        entry.endsWith(".ports"),
      );
      if (file) {
        const ports = JSON.parse(readFileSync(join(PORTS_DIR, file), "utf8"));
        if (Array.isArray(ports.nats) && ports.nats[0]) return ports.nats[0];
      }
    } catch {
      /* retry */
    }
    await delay(25);
  }
  throw new Error("nats-server did not report a bound port");
}

const url = await boundUrl();
const hostSource = AUTHENTICATED ? { url, creds: ALICE_CREDS } : { url };
const hostBundle = await resolveNatsConnectionBundle(hostSource, {
  identity: SIGNED ? "signed" : "off",
});
const hostNc = await connect({
  ...hostBundle.connectionOptions,
  name: "pi-headless-smoke-host",
});

let lastModelPrompt;
let holdModelPrompt = false;
let releaseModelPrompt;
const subscribers = new Set();
const fakePiSession = {
  subscribe(listener) {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
  async prompt(body) {
    lastModelPrompt = body;
    if (holdModelPrompt) {
      await new Promise((resolve) => {
        releaseModelPrompt = resolve;
      });
      return;
    }
    for (const listener of subscribers) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: body },
      });
    }
  },
  dispose() {},
};

const owner = "smoke";
const name = "control";
const sessionId = "session";
const minSenderTrust = STRICT ? "signed" : "any";
const logs = [];
const managed = new ManagedSession({
  nc: hostNc,
  owner,
  sessionId,
  cwd: "/tmp",
  model: undefined,
  thinkingLevel: undefined,
  maxLifetimeS: 0,
  piSession: fakePiSession,
  signer: hostBundle.signer,
  minSenderTrust,
  logger: (line) => logs.push(line),
});
await managed.start();

const manager = {
  list: () => [managed.summary()],
  spawn: async (spec) => ({
    session_id: "spawned",
    subject: "agents.prompt.pi-headless.smoke.spawned",
    heartbeat_subject: "agents.hb.pi-headless.smoke.spawned",
    status_subject: "agents.status.pi-headless.smoke.spawned",
    cwd: spec.cwd,
    model: undefined,
    thinking_level: undefined,
    max_lifetime_s: 10,
    created_at: new Date().toISOString(),
    instance_id: "fake-instance",
  }),
  stopOne: async (id) => ({ ok: true, session_id: id }),
};
const controller = new Controller({
  nc: hostNc,
  owner,
  name,
  manager,
  signer: hostBundle.signer,
  minSenderTrust,
  logger: (line) => logs.push(line),
});
await controller.start();

const callerBundle = await resolveNatsConnectionBundle(
  AUTHENTICATED ? { url, creds: CAROL_CREDS } : { url },
  { identity: STRICT ? "signed" : "off" },
);
const callerNc = await connect({
  ...callerBundle.connectionOptions,
  name: "pi-headless-smoke-caller",
});
const agents = new Agents({
  nc: callerNc,
  ...(callerBundle.signer ? { identity: { signer: callerBundle.signer } } : {}),
});

try {
  const found = (await agents.discover()).filter(
    (agent) => agent.agent === "pi-headless" && agent.owner === owner,
  );
  const controllerAgent = found.find(
    (agent) => agent.metadata.role === "controller",
  );
  const sessionAgent = found.find((agent) => agent.metadata.role === "session");
  assert.ok(controllerAgent, "controller was not discoverable");
  assert.ok(sessionAgent, "session was not discoverable");
  assert.equal(controllerAgent.minSenderTrust, minSenderTrust);
  assert.equal(sessionAgent.minSenderTrust, minSenderTrust);

  if (SIGNED) {
    assert.ok(controllerAgent.identity, "signed controller has no identity");
    assert.equal(controllerAgent.idSigVerified, true);
    assert.equal(sessionAgent.idSigVerified, true);
    assert.equal(
      sessionAgent.identity,
      controllerAgent.identity,
      "logical services on one connection must share one cryptographic identity",
    );
  } else {
    assert.equal(controllerAgent.identity, undefined);
    assert.equal(sessionAgent.identity, undefined);
  }

  const controllerText = await collectText(controllerAgent, "help");
  assert.match(controllerText, /control-plane agent/);
  const prompt = STRICT
    ? "strict prompt"
    : SIGNED
      ? "signed-host prompt"
      : "plain prompt";
  assert.equal(await collectText(sessionAgent, prompt), prompt);
  assert.equal(
    lastModelPrompt,
    prompt,
    "sender metadata leaked into the PI model prompt",
  );

  const list = await callerNc.request(controllerListSubject(owner, name), "", {
    timeout: 2_000,
  });
  assert.equal(JSON.parse(list.string()).sessions[0].session_id, sessionId);
  const spawnReply = await callerNc.request(
    controllerSpawnSubject(owner, name),
    JSON.stringify({ cwd: "/tmp" }),
    { timeout: 2_000 },
  );
  assert.equal(JSON.parse(spawnReply.string()).session_id, "spawned");
  const stopReply = await callerNc.request(
    controllerStopSubject(owner, name),
    JSON.stringify({ session_id: "spawned" }),
    { timeout: 2_000 },
  );
  assert.deepEqual(JSON.parse(stopReply.string()), {
    ok: true,
    session_id: "spawned",
  });

  if (!STRICT) {
    holdModelPrompt = true;
    const settlement = collectRaw(
      callerNc,
      sessionAgent.promptSubject,
      JSON.stringify({ prompt: "shutdown settlement" }),
    );
    for (let i = 0; i < 100 && lastModelPrompt !== "shutdown settlement"; i++) {
      await delay(10);
    }
    assert.equal(lastModelPrompt, "shutdown settlement");
    await managed.dispose();
    const settled = await settlement;
    assert.equal(settled.errorCode, 500);
    assert.equal(settled.terminated, true);
    releaseModelPrompt?.();
  }

  if (STRICT) {
    const raw = await collectRaw(
      callerNc,
      sessionAgent.promptSubject,
      JSON.stringify({ prompt: "raw" }),
    );
    assert.equal(raw.errorCode, 401);
    assert.equal(
      raw.chunks.length,
      0,
      "signed-only refusal must happen before ack",
    );
    assert.equal(raw.terminated, true);
  }

  assert.ok(
    logs.some((line) => line.includes("sender=")),
    "safe sender diagnostic was not logged",
  );
  process.stdout.write(
    `pi-headless identity smoke passed (${SIGNED ? "signed/any" : STRICT ? "off/signed" : "off/any"})\n`,
  );
} finally {
  await agents.close().catch(() => undefined);
  await callerNc.close();
  callerBundle.wipe();
  await controller.stop();
  await managed.dispose();
  await hostNc.close();
  hostBundle.wipe();
  server.kill();
}

async function collectText(agent, prompt) {
  let text = "";
  for await (const event of await agent.prompt(prompt)) {
    if (event.type === "response") text += event.text;
  }
  return text;
}

async function collectRaw(nc, subject, payload) {
  const inbox = createInbox();
  const sub = nc.subscribe(inbox);
  const chunks = [];
  let errorCode;
  let terminated = false;
  const done = (async () => {
    for await (const msg of sub) {
      const code = msg.headers?.get("Nats-Service-Error-Code");
      const hasHeaders = msg.headers && [...msg.headers].length > 0;
      if (code) {
        errorCode = Number(code);
      } else if (msg.data.byteLength === 0 && !hasHeaders) {
        terminated = true;
        sub.unsubscribe();
      } else {
        chunks.push(msg.string());
      }
    }
  })();
  nc.publish(subject, payload, { reply: inbox });
  await Promise.race([done, delay(2_000)]);
  sub.unsubscribe();
  return { chunks, errorCode, terminated };
}

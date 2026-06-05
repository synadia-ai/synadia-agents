#!/usr/bin/env bun
import { createConnection, createServer } from "node:net";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type StreamMessage } from "@synadia-ai/agents";
import type { OpenCodeBridgeClient } from "../src/bridge.js";
import type { OpenCodeChannelConfig } from "../src/config.js";
import { createOpenCodeAgentService } from "../src/service.js";

const encoder = new TextEncoder();
const name = `smoke-${Math.random().toString(36).slice(2, 8)}`;

const nats = await ensureNats();
const config: OpenCodeChannelConfig = {
  nats: { url: nats.url },
  agent: {
    owner: "smoke",
    name,
    subjectToken: "opencode",
    heartbeatIntervalS: 1,
    keepaliveIntervalS: 1,
  },
  opencode: {
    mode: "attached",
    baseUrl: "http://127.0.0.1:4096",
    hostname: "127.0.0.1",
    port: 4096,
    directory: process.cwd(),
    permissionPolicy: "query",
    permissionTimeoutMs: 5000,
  },
};

let permissionDecision: string | undefined;
const fakeOpenCodeClient: OpenCodeBridgeClient = {
  mode: "attached",
  async *prompt(input) {
    yield { type: "status", text: `connected fake OpenCode session for ${input.sessionId ?? "new"}` };
    yield {
      type: "permission",
      question: "OpenCode requests permission for smoke-tool. Reply yes/once, always, or no.",
      timeoutMs: 5000,
      decide: async (reply) => { permissionDecision = reply; },
    };
    yield { type: "response", text: `fake OpenCode response to ${input.prompt}; decision=${permissionDecision}` };
  },
};

const nc = await natsConnect({ servers: nats.url });
const callerNc = await natsConnect({ servers: nats.url });
const service = createOpenCodeAgentService({
  nc,
  config,
  version: "0.1.0-smoke",
  client: fakeOpenCodeClient,
});

try {
  await service.start();
  const agents = new Agents({ nc: callerNc });
  const found = await agents.discover({ timeoutMs: 1000, filter: { agent: "opencode", name } });
  if (found.length !== 1) throw new Error(`expected one opencode smoke agent, found ${found.length}`);
  const agent = found[0]!;

  assertEqual(agent.metadata["agent"], "opencode", "service metadata agent");
  assertEqual(agent.metadata["owner"], "smoke", "service metadata owner");
  assertEqual(agent.metadata["session"], name, "service metadata session");
  assertEqual(agent.metadata["protocol_version"], "0.3", "service metadata protocol_version");
  assertEqual(agent.metadata["opencode_mode"], "attached", "service metadata opencode_mode");
  assertEqual(agent.metadata["permission_policy"], "query", "service metadata permission_policy");
  assertEqual(agent.promptEndpoint.subject, service.subject.prompt, "prompt endpoint subject");
  assertEqual(agent.promptEndpoint.queueGroup, "agents", "prompt endpoint queue group");
  assertEqual(agent.promptEndpoint.attachmentsOk, false, "prompt endpoint attachments_ok");
  if (!agent.promptEndpoint.metadata["max_payload"]) throw new Error("prompt endpoint missing max_payload");
  const statusEndpoint = agent.endpoints.find((e) => e.name === "status");
  assertEqual(statusEndpoint?.subject, service.subject.status, "status endpoint subject");
  assertEqual(statusEndpoint?.queueGroup, "agents", "status endpoint queue group");

  const messages: StreamMessage[] = [];
  for await (const msg of await agent.prompt("hello smoke")) {
    messages.push(msg);
    if (msg.type === "query") await msg.reply("always");
  }

  const first = messages[0];
  if (first?.type !== "status" || first.status !== "ack") throw new Error("missing leading ack status");
  if (!messages.some((m) => m.type === "query" && m.prompt.includes("smoke-tool"))) throw new Error("missing permission query chunk");
  if (!messages.some((m) => m.type === "status" && m.status.includes("OpenCode permission always"))) throw new Error("missing permission status after query reply");
  if (!messages.some((m) => m.type === "response" && m.text.includes("decision=always"))) throw new Error("missing fake OpenCode response with query decision");
  const last = messages.at(-1);
  if (last?.type !== "status" || last.status !== "done") throw new Error("missing done terminator status");

  await assertUnsupportedAttachmentReturns400(callerNc, service.subject.prompt);

  console.log(JSON.stringify({
    natsUrl: nats.url,
    subject: service.subject.prompt,
    status: service.subject.status,
    metadata: agent.metadata,
    promptEndpoint: agent.promptEndpoint,
    messageTypes: messages.map((m) => m.type),
  }, null, 2));
} finally {
  await service.stop();
  await nc.close();
  await callerNc.close();
  await nats.close();
}

async function assertUnsupportedAttachmentReturns400(callerNc: typeof nc, subject: string): Promise<void> {
  const reply = `_INBOX.opencode-attachment-${Math.random().toString(36).slice(2, 8)}`;
  const sub = callerNc.subscribe(reply);
  await callerNc.flush();
  callerNc.publish(
    subject,
    encoder.encode(JSON.stringify({
      prompt: "attachment should be rejected",
      attachments: [{ filename: "note.txt", content: "QUJD" }],
    })),
    { reply },
  );
  const frames = [];
  const iterator = sub[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await withTimeout(iterator.next(), 5000, "timed out waiting for attachment rejection frames");
      if (result.done) break;
      frames.push(result.value);
      if (frames.some((m) => m.headers?.get("Nats-Service-Error-Code")) && frames.some((m) => !m.headers && m.data.length === 0)) break;
    }
  } finally {
    sub.unsubscribe();
  }
  const error = frames.find((m) => m.headers?.get("Nats-Service-Error-Code"));
  assertEqual(error?.headers?.get("Nats-Service-Error-Code"), "400", "unsupported attachment error code");
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function ensureNats(): Promise<{ url: string; close(): Promise<void> }> {
  if (process.env["OPENCODE_SMOKE_USE_EXTERNAL_NATS"] === "1" && process.env["NATS_URL"]) {
    return { url: process.env["NATS_URL"], close: async () => {} };
  }
  const port = await freePort();
  const url = `nats://127.0.0.1:${port}`;
  const proc = Bun.spawn(["nats-server", "-a", "127.0.0.1", "-p", String(port)], {
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    await waitForPort(port, 5000);
  } catch (err) {
    proc.kill();
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    throw new Error(`failed to start disposable nats-server: ${(err as Error).message}${stderr ? `\n${stderr}` : ""}`);
  }
  return {
    url,
    close: async () => {
      proc.kill();
      await proc.exited.catch(() => undefined);
    },
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("failed to allocate free port"));
      });
    });
    server.on("error", reject);
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port }, () => {
          socket.end();
          resolve();
        });
        socket.on("error", reject);
      });
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error(`port ${port} did not open within ${timeoutMs}ms`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

#!/usr/bin/env bun
import { createConnection, createServer } from "node:net";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type StreamMessage } from "@synadia-ai/agents";
import { ManagedCodexRuntime } from "../src/managed-runtime.js";
import { createCodexAgentService } from "../src/service.js";
import type { CodexChannelConfig } from "../src/config.js";

const nats = await ensureNats();
const config: CodexChannelConfig = {
  nats: { url: nats.url },
  agent: { owner: "smoke", session: "managed", subjectToken: "codex", heartbeatIntervalS: 1, keepaliveIntervalS: 1 },
  codex: { mode: "managed", codexBin: "bun", permissionPolicy: "reject" },
  manager: { enabled: false, autoExposeCurrentSessions: false, autoExposeFutureSessions: false, watchMode: "event-plus-poll", watchIntervalMs: 7500, staleGraceIntervals: 3, exposeEphemeralLoadedSessions: false },
};

const nc = await natsConnect({ servers: nats.url });
const callerNc = await natsConnect({ servers: nats.url });
const runtime = new ManagedCodexRuntime({ config, command: "bun", args: ["scripts/fake-codex-app-server.ts"], cwd: process.cwd() });
const service = createCodexAgentService({ nc, config, version: "0.1.0-smoke", client: runtime });
try {
  await runtime.start();
  await service.start();
  const agents = new Agents({ nc: callerNc });
  const found = await agents.discover({ timeoutMs: 1000, filter: { agent: "codex", name: "managed" } });
  if (found.length !== 1) throw new Error(`expected one managed codex agent, found ${found.length}`);
  const messages: StreamMessage[] = [];
  for await (const msg of await found[0]!.prompt("hello runtime")) messages.push(msg);
  const responseText = messages.filter((m): m is Extract<StreamMessage, { type: "response" }> => m.type === "response").map((m) => m.text).join("");
  if (!responseText.includes("fake Codex response to hello runtime")) throw new Error(`missing managed response text: ${responseText}`);
  if (messages.some((m) => m.type === "response" && m.text === "")) throw new Error("managed bridge emitted an empty response chunk");
  console.log(JSON.stringify({ ok: true, natsUrl: nats.url, subject: service.subject.prompt, messageTypes: messages.map((m) => m.type), responseText, threadId: runtime.threadId ? "[REDACTED]" : null }, null, 2));
} finally {
  await service.stop();
  await runtime.close();
  await nc.drain();
  await callerNc.drain();
  await nats.close();
}

async function ensureNats(): Promise<{ url: string; close(): Promise<void> }> {
  const port = await freePort();
  const url = `nats://127.0.0.1:${port}`;
  const proc = Bun.spawn(["nats-server", "-a", "127.0.0.1", "-p", String(port)], { stdout: "ignore", stderr: "pipe" });
  await waitForPort(port, 5000).catch(async (err) => {
    proc.kill();
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    throw new Error(`failed to start disposable nats-server: ${(err as Error).message}${stderr ? `\n${stderr}` : ""}`);
  });
  return { url, close: async () => { proc.kill(); await proc.exited.catch(() => undefined); } };
}
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("failed to allocate free port")));
    });
    server.on("error", reject);
  });
}
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port }, () => { socket.end(); resolve(); });
        socket.on("error", reject);
      });
      return;
    } catch { await Bun.sleep(50); }
  }
  throw new Error(`port ${port} did not open within ${timeoutMs}ms`);
}

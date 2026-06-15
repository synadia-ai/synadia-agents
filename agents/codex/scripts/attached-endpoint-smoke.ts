#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type StreamMessage } from "@synadia-ai/agents";
import { AttachedCodexRuntime } from "../src/attached-runtime.js";
import { createCodexAgentService } from "../src/service.js";
import type { CodexChannelConfig } from "../src/config.js";

const endpoint = await startFakeEndpoint();
const nats = await ensureNats();
const config: CodexChannelConfig = {
  nats: { url: nats.url },
  agent: { owner: "smoke", session: "attached", subjectToken: "codex", heartbeatIntervalS: 1, keepaliveIntervalS: 1 },
  codex: { mode: "attached", codexBin: "codex", endpoint: `unix://${endpoint.socketPath}`, threadId: "private-thread", publicAlias: "attached", permissionPolicy: "external-owner" },
  manager: { enabled: false, autoExposeCurrentSessions: false, autoExposeFutureSessions: false, watchMode: "event-plus-poll", watchIntervalMs: 7500, staleGraceIntervals: 3, exposeEphemeralLoadedSessions: false },
};
const nc = await natsConnect({ servers: nats.url });
const callerNc = await natsConnect({ servers: nats.url });
const runtime = new AttachedCodexRuntime({ config, streamPreflightPrompt: "preflight", turnTimeoutMs: 5000 });
const service = createCodexAgentService({ nc, config, version: "0.1.0-smoke", client: runtime });
try {
  const preflight = await runtime.start();
  if (!preflight.selectedThreadFound || !preflight.streamOk) throw new Error(`attached preflight failed: ${JSON.stringify(preflight)}`);
  await service.start();
  const agents = new Agents({ nc: callerNc });
  const found = await agents.discover({ timeoutMs: 1000, filter: { agent: "codex", name: "attached" } });
  if (found.length !== 1) throw new Error(`expected one attached codex agent, found ${found.length}`);
  if (found[0]!.metadata["permission_mode"] !== "external-owner") throw new Error("attached metadata did not report permission_mode=external-owner");
  const messages: StreamMessage[] = [];
  for await (const msg of await found[0]!.prompt("hello attached")) messages.push(msg);
  const responseText = messages.filter((m): m is Extract<StreamMessage, { type: "response" }> => m.type === "response").map((m) => m.text).join("");
  if (!responseText.includes("attached response to hello attached")) throw new Error(`missing attached response text: ${responseText}`);
  console.log(JSON.stringify({ ok: true, natsUrl: nats.url, subject: service.subject.prompt, preflight, metadata: found[0]!.metadata, messageTypes: messages.map((m) => m.type), responseText, privateThreadId: "[REDACTED]", endpoint: "[REDACTED]" }, null, 2));
} finally {
  await service.stop();
  await runtime.close();
  await nc.drain();
  await callerNc.drain();
  await nats.close();
  await endpoint.close();
}

async function startFakeEndpoint(): Promise<{ socketPath: string; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "codex-attached-smoke-"));
  const socketPath = join(dir, "codex.sock");
  const server = createServer((socket) => serveJsonRpcSocket(socket));
  await new Promise<void>((resolve, reject) => { server.listen(socketPath, resolve); server.once("error", reject); });
  return { socketPath, close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); } };
}
function serveJsonRpcSocket(socket: Socket): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let nextTurn = 1;
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") send(socket, { id: message.id, result: { userAgent: "fake-attached/0.1", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" } });
      else if (message.method === "initialized") {}
      else if (message.method === "thread/loaded/list" || message.method === "thread/list") send(socket, { id: message.id, result: { threads: [thread()] } });
      else if (message.method === "thread/read") send(socket, { id: message.id, result: { thread: thread() } });
      else if (message.method === "thread/resume") send(socket, { id: message.id, result: { thread: thread(), approvalPolicy: "never", approvalsReviewer: "user" } });
      else if (message.method === "turn/start") {
        const turnId = `turn-${nextTurn++}`;
        const text = message.params.input?.find((item: any) => item.type === "text")?.text ?? "";
        send(socket, { id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
        send(socket, { method: "agent/message/delta", params: { threadId: "private-thread", turnId, delta: `attached response to ${text}` } });
        send(socket, { method: "turn/completed", params: { threadId: "private-thread", turnId, turn: { id: turnId, status: "completed" } } });
      } else send(socket, { id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    }
  });
}
function thread(): Record<string, unknown> { return { id: "private-thread", status: { type: "idle" }, turns: [] }; }
function send(socket: Socket, message: unknown): void { socket.write(`${JSON.stringify(message)}\n`); }

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
    server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("failed to allocate free port"))); });
    server.on("error", reject);
  });
}
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await new Promise<void>((resolve, reject) => { const socket = createConnection({ host: "127.0.0.1", port }, () => { socket.end(); resolve(); }); socket.on("error", reject); }); return; }
    catch { await Bun.sleep(50); }
  }
  throw new Error(`port ${port} did not open within ${timeoutMs}ms`);
}

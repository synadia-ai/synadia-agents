#!/usr/bin/env bun
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";
import type { CodexChannelConfig } from "../src/config.js";
import { CodexSessionManager } from "../src/session-manager.js";
import { assertNoPrivateValues } from "../src/redaction.js";

const decoder = new TextDecoder();

const fakeEndpoint = await startFakeFutureEndpoint();
const nats = await ensureNats();
const privateEndpoint = `unix://${fakeEndpoint.socketPath}`;
const privateValues = [privateEndpoint, fakeEndpoint.socketPath, "thread-future-eligible", "thread-future-private-empty"];

const config: CodexChannelConfig = {
  nats: { url: nats.url },
  agent: { owner: "future-smoke", session: "manager", subjectToken: "codex", heartbeatIntervalS: 1, keepaliveIntervalS: 1 },
  codex: { mode: "manager", codexBin: "codex", endpoint: privateEndpoint, permissionPolicy: "external-owner" },
  manager: {
    enabled: true,
    autoExposeCurrentSessions: false,
    autoExposeFutureSessions: true,
    endpoints: [privateEndpoint],
    watchMode: "event-plus-poll",
    watchIntervalMs: 200,
    staleGraceIntervals: 2,
    exposeEphemeralLoadedSessions: false,
  },
};

const nc = await natsConnect({ servers: nats.url });
const callerNc = await natsConnect({ servers: nats.url });
const manager = new CodexSessionManager({ nc, config, version: "0.1.0-future-smoke", turnTimeoutMs: 5000 });

try {
  const initial = await manager.start();
  if (initial.length !== 0) throw new Error(`future manager should start private with no exposed sessions, got ${initial.length}`);

  const heartbeatSub = callerNc.subscribe("agents.hb.codex.future-smoke.>");
  fakeEndpoint.addThread(thread("thread-future-eligible"));
  const future = await waitForSnapshots(manager, 1, 5000, "future eligible thread did not register");
  const snapshot = future[0]!;
  assertNoPrivateValues("future public snapshot", {
    publicAlias: snapshot.publicAlias,
    promptSubject: snapshot.promptSubject,
    statusSubject: snapshot.statusSubject,
    heartbeatSubject: snapshot.heartbeatSubject,
    endpointFingerprint: snapshot.endpointFingerprint,
    state: snapshot.state,
  }, privateValues);
  if (!snapshot.promptSubject.endsWith(`.${snapshot.publicAlias}`)) throw new Error("prompt subject does not use derived public alias");

  const heartbeat = await nextMessage(heartbeatSub, 2500, "timed out waiting for future heartbeat");
  if (heartbeat.subject.includes("thread-future-eligible")) throw new Error("heartbeat subject leaked raw thread id");
  assertNoPrivateValues("future heartbeat", { subject: heartbeat.subject, payload: decodeBody(heartbeat.data) }, privateValues);
  heartbeatSub.unsubscribe();

  const agents = new Agents({ nc: callerNc });
  let discovered = await discoverCodexAgents(agents);
  if (discovered.filter((agent) => agent.metadata["session"] === snapshot.publicAlias).length !== 1) {
    throw new Error("future eligible thread was not discoverable exactly once");
  }
  assertNoPrivateValues("future discovery", discovered.map((agent) => ({ metadata: agent.metadata, endpoint: agent.promptEndpoint })), privateValues);

  fakeEndpoint.addThread({ ...thread("thread-future-private-empty"), ephemeral: true, turns: [] });
  await Bun.sleep(500);
  const afterPrivate = manager.snapshots;
  if (afterPrivate.length !== 1) throw new Error(`future non-eligible thread should stay private, got ${afterPrivate.length} exposed sessions`);

  const afterManualRescan = await manager.rescan();
  if (afterManualRescan.length !== 1 || afterManualRescan[0]?.publicAlias !== snapshot.publicAlias) {
    throw new Error("manual rescan was not idempotent");
  }

  await fakeEndpoint.close();
  const stale = await manager.rescan();
  if (stale.length !== 1 || stale[0]?.state !== "stale") throw new Error("first missed inventory should mark session stale");
  const stopped = await manager.rescan();
  if (stopped.length !== 0) throw new Error("second missed inventory should stop stale service after grace");
  discovered = await discoverCodexAgents(agents);
  if (discovered.some((agent) => agent.metadata["session"] === snapshot.publicAlias)) {
    throw new Error("stale service remained discoverable after endpoint loss cleanup");
  }

  const publicTranscript = {
    natsUrl: nats.url,
    futureAlias: snapshot.publicAlias,
    promptSubject: snapshot.promptSubject,
    statusSubject: snapshot.statusSubject,
    heartbeatSubject: snapshot.heartbeatSubject,
    manualRescanSessions: afterManualRescan.length,
    staleState: stale[0]?.state,
    stoppedSessions: stopped.length,
  };
  assertNoPrivateValues("future smoke transcript", publicTranscript, privateValues);
  console.log(JSON.stringify(publicTranscript, null, 2));
} finally {
  await manager.stop().catch(() => undefined);
  await nc.drain().catch(() => undefined);
  await callerNc.drain().catch(() => undefined);
  await nats.close().catch(() => undefined);
  await fakeEndpoint.close().catch(() => undefined);
}

async function discoverCodexAgents(agents: Agents): Promise<Awaited<ReturnType<Agents["discover"]>>> {
  try {
    return await agents.discover({ timeoutMs: 1000, filter: { agent: "codex", owner: "future-smoke" } });
  } catch (err) {
    if (err instanceof Error && /no responders/i.test(err.message)) return [] as Awaited<ReturnType<Agents["discover"]>>;
    throw err;
  }
}

async function waitForSnapshots(manager: CodexSessionManager, count: number, timeoutMs: number, message: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (manager.snapshots.length === count) return manager.snapshots;
    await Bun.sleep(50);
  }
  throw new Error(`${message}; saw ${manager.snapshots.length}`);
}

async function nextMessage(sub: AsyncIterable<{ subject: string; data: Uint8Array }>, timeoutMs: number, message: string): Promise<{ subject: string; data: Uint8Array }> {
  const iterator = sub[Symbol.asyncIterator]();
  const result = await withTimeout(iterator.next(), timeoutMs, message);
  if (result.done) throw new Error(message);
  return result.value;
}

function decodeBody(data: Uint8Array): unknown {
  if (data.length === 0) return null;
  const text = decoder.decode(data);
  try { return JSON.parse(text); } catch { return text; }
}

async function startFakeFutureEndpoint(): Promise<{ socketPath: string; addThread(thread: Record<string, unknown>): void; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "codex-future-smoke-"));
  const socketPath = join(dir, "codex.sock");
  const threads = new Map<string, Record<string, unknown>>();
  const sockets = new Set<Socket>();
  let closed = false;
  const server = createServer((socket) => serveJsonRpcSocket(socket, threads, sockets));
  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, resolve);
    server.once("error", reject);
  });
  return {
    socketPath,
    addThread: (row) => {
      const id = String(row.id ?? "");
      threads.set(id, row);
      for (const socket of sockets) send(socket, { method: "thread/started", params: { threadId: id, thread: row } });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server, sockets, dir);
    },
  };
}

function serveJsonRpcSocket(socket: Socket, threads: Map<string, Record<string, unknown>>, sockets: Set<Socket>): void {
  sockets.add(socket);
  socket.setEncoding("utf8");
  socket.once("close", () => sockets.delete(socket));
  let buffer = "";
  let selectedThread = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") send(socket, { id: message.id, result: { userAgent: "fake-future/0.1", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" } });
      else if (message.method === "initialized") {}
      else if (message.method === "thread/loaded/list") send(socket, { id: message.id, result: { threads: [...threads.values()] } });
      else if (message.method === "thread/list") send(socket, { id: message.id, result: { threads: [...threads.values()] } });
      else if (message.method === "thread/read") {
        const row = threads.get(message.params.threadId);
        if (!row) send(socket, { id: message.id, error: { code: -32004, message: "thread not found" } });
        else send(socket, { id: message.id, result: { thread: row } });
      } else if (message.method === "thread/resume") {
        const row = threads.get(message.params.threadId);
        if (!row) send(socket, { id: message.id, error: { code: -32004, message: "thread not found" } });
        else { selectedThread = message.params.threadId; send(socket, { id: message.id, result: { thread: row, approvalPolicy: "never", approvalsReviewer: "user" } }); }
      } else if (message.method === "turn/start") {
        const turnId = "turn-future";
        send(socket, { id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
        send(socket, { method: "agent/message/delta", params: { threadId: selectedThread, turnId, delta: "future response" } });
        send(socket, { method: "turn/completed", params: { threadId: selectedThread, turnId, turn: { id: turnId, status: "completed" } } });
      } else send(socket, { id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    }
  });
}

async function closeServer(server: Server, sockets: Set<Socket>, dir: string): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}

function thread(id: string): Record<string, unknown> {
  return { id, status: { type: "idle" }, ephemeral: false, turns: [{ id: `${id}-turn` }] };
}

function send(socket: Socket, message: unknown): void { socket.write(`${JSON.stringify(message)}\n`); }

async function ensureNats(): Promise<{ url: string; close(): Promise<void> }> {
  if (process.env["CODEX_SMOKE_USE_EXTERNAL_NATS"] === "1" && process.env["NATS_URL"]) return { url: process.env["NATS_URL"], close: async () => {} };
  const port = await freePort();
  const url = `nats://127.0.0.1:${port}`;
  const proc = Bun.spawn(["nats-server", "-a", "127.0.0.1", "-p", String(port)], { stdout: "ignore", stderr: "pipe" });
  try { await waitForPort(port, 5000); }
  catch (err) {
    proc.kill();
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    throw new Error(`failed to start disposable nats-server: ${(err as Error).message}${stderr ? `\n${stderr}` : ""}`);
  }
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

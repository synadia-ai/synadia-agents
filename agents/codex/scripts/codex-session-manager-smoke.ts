#!/usr/bin/env bun
import { createConnection, createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";
import type { CodexChannelConfig } from "../src/config.js";
import { CodexSessionManager } from "../src/session-manager.js";
import { assertNoPrivateValues } from "../src/redaction.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const fakeEndpoint = await startFakeManagerEndpoint();
const nats = await ensureNats();
const privateEndpoint = `unix://${fakeEndpoint.socketPath}`;
const privateValues = [privateEndpoint, fakeEndpoint.socketPath, "thread-fixture-alpha", "thread-fixture-beta"];

const config: CodexChannelConfig = {
  nats: { url: nats.url },
  agent: { owner: "manager-smoke", session: "manager", subjectToken: "codex", heartbeatIntervalS: 1, keepaliveIntervalS: 1 },
  codex: { mode: "manager", codexBin: "codex", endpoint: privateEndpoint, permissionPolicy: "external-owner" },
  manager: {
    enabled: true,
    autoExposeCurrentSessions: true,
    autoExposeFutureSessions: false,
    endpoints: [privateEndpoint],
    watchMode: "event-plus-poll",
    watchIntervalMs: 7500,
    staleGraceIntervals: 3,
    exposeEphemeralLoadedSessions: false,
  },
};

const nc = await natsConnect({ servers: nats.url });
const callerNc = await natsConnect({ servers: nats.url });
const manager = new CodexSessionManager({ nc, config, version: "0.1.0-smoke", turnTimeoutMs: 5000 });

try {
  const snapshots = await manager.start();
  if (snapshots.length !== 2) throw new Error(`expected two eligible managed sessions, got ${snapshots.length}`);
  for (const snapshot of snapshots) {
    assertNoPrivateValues("manager public snapshot", {
      publicAlias: snapshot.publicAlias,
      promptSubject: snapshot.promptSubject,
      statusSubject: snapshot.statusSubject,
      heartbeatSubject: snapshot.heartbeatSubject,
      endpointFingerprint: snapshot.endpointFingerprint,
    }, privateValues);
  }

  const agents = new Agents({ nc: callerNc });
  const discovered = await agents.discover({ timeoutMs: 1000, filter: { agent: "codex", owner: "manager-smoke" } });
  const aliases = new Set(snapshots.map((snapshot) => snapshot.publicAlias));
  for (const alias of aliases) {
    const found = discovered.find((agent) => agent.metadata["session"] === alias);
    if (!found) throw new Error(`manager session ${alias} was not discoverable`);
    assertNoPrivateValues("$SRV.INFO/discovery", { metadata: found.metadata, endpoint: found.promptEndpoint }, privateValues);
  }

  const a = snapshots.find((snapshot) => snapshot.privateKey.includes("thread-fixture-alpha"));
  const b = snapshots.find((snapshot) => snapshot.privateKey.includes("thread-fixture-beta"));
  if (!a || !b) throw new Error("missing alpha/beta session snapshots");
  const subA = callerNc.subscribe(a.heartbeatSubject);
  const subB = callerNc.subscribe(b.heartbeatSubject);
  const statusA = await requestJson(callerNc, a.statusSubject, "");
  const statusB = await requestJson(callerNc, b.statusSubject, "");
  if (statusA.session !== a.publicAlias) throw new Error("status A session alias mismatch");
  if (statusB.session !== b.publicAlias) throw new Error("status B session alias mismatch");
  assertNoPrivateValues("status A", statusA, privateValues);
  assertNoPrivateValues("status B", statusB, privateValues);
  assertNoPrivateValues("heartbeat A", await nextJson(subA, 2500, "timed out waiting for heartbeat A"), privateValues);
  assertNoPrivateValues("heartbeat B", await nextJson(subB, 2500, "timed out waiting for heartbeat B"), privateValues);
  subA.unsubscribe();
  subB.unsubscribe();

  const agentA = discovered.find((agent) => agent.metadata["session"] === a.publicAlias)!;
  const agentB = discovered.find((agent) => agent.metadata["session"] === b.publicAlias)!;
  const streamA = await agentA.prompt("prompt-for-a");
  const streamB = await agentB.prompt("prompt-for-b");
  const responseA = await collectResponseText(streamA);
  const responseB = await collectResponseText(streamB);
  if (!responseA.includes("thread-fixture-alpha") || responseA.includes("thread-fixture-beta") || !responseA.includes("prompt-for-a")) {
    throw new Error(`session A prompt isolation failed: ${responseA}`);
  }
  if (!responseB.includes("thread-fixture-beta") || responseB.includes("thread-fixture-alpha") || !responseB.includes("prompt-for-b")) {
    throw new Error(`session B prompt isolation failed: ${responseB}`);
  }

  const rawError = await rawPromptRoundTrip(callerNc, a.promptSubject, "manager explode");
  assertErrorCode(rawError.frames, "500", "manager prompt handler error");
  assertNoPrivateValues("prompt error", rawError.frames, privateValues);

  const publicTranscript = {
    natsUrl: nats.url,
    sessions: snapshots.map((snapshot) => ({
      publicAlias: snapshot.publicAlias,
      promptSubject: snapshot.promptSubject,
      statusSubject: snapshot.statusSubject,
      heartbeatSubject: snapshot.heartbeatSubject,
    })),
    discoverySessions: discovered.map((agent) => agent.metadata["session"]),
    statusSessions: [statusA.session, statusB.session],
    promptIsolation: {
      a: responseA.replace(/thread-fixture-alpha/g, "thread-[redacted-for-output]"),
      b: responseB.replace(/thread-fixture-beta/g, "thread-[redacted-for-output]"),
    },
    promptError500: summarizeFrames(rawError.frames),
  };
  assertNoPrivateValues("public smoke transcript", publicTranscript, privateValues);
  console.log(JSON.stringify(publicTranscript, null, 2));
} finally {
  await manager.stop().catch(() => undefined);
  await nc.drain().catch(() => undefined);
  await callerNc.drain().catch(() => undefined);
  await nats.close().catch(() => undefined);
  await fakeEndpoint.close().catch(() => undefined);
}

async function collectResponseText(messages: AsyncIterable<{ type: string; text?: string }>): Promise<string> {
  const chunks: string[] = [];
  for await (const message of messages) if (message.type === "response" && message.text) chunks.push(message.text);
  return chunks.join("");
}

async function requestJson(callerNc: typeof nc, subject: string, payload: string): Promise<Record<string, unknown>> {
  const msg = await callerNc.request(subject, encoder.encode(payload), { timeout: 2500 });
  const decoded = decodeBody(msg.data);
  if (!isRecord(decoded)) throw new Error(`expected JSON object response on ${subject}`);
  return decoded;
}

async function nextJson(sub: AsyncIterable<{ data: Uint8Array }>, timeoutMs: number, message: string): Promise<Record<string, unknown>> {
  const iterator = sub[Symbol.asyncIterator]();
  const result = await withTimeout(iterator.next(), timeoutMs, message);
  if (result.done) throw new Error(message);
  const decoded = decodeBody(result.value.data);
  if (!isRecord(decoded)) throw new Error("expected JSON object heartbeat");
  return decoded;
}

interface RawFrame {
  readonly kind: "chunk" | "error" | "terminator";
  readonly bytes: number;
  readonly errorCode?: string;
  readonly errorDescription?: string;
  readonly decoded?: unknown;
}

async function rawPromptRoundTrip(callerNc: typeof nc, subject: string, payload: string): Promise<{ frames: RawFrame[] }> {
  const reply = `_INBOX.codex-manager-raw-${Math.random().toString(36).slice(2, 8)}`;
  const sub = callerNc.subscribe(reply);
  const frames: RawFrame[] = [];
  await callerNc.flush();
  callerNc.publish(subject, encoder.encode(payload), { reply });
  const iterator = sub[Symbol.asyncIterator]();
  try {
    for (;;) {
      const result = await withTimeout(iterator.next(), 5000, `timed out waiting for raw protocol frames on ${reply}`);
      if (result.done) break;
      const frame = describeFrame(result.value);
      frames.push(frame);
      if (frame.kind === "terminator") break;
    }
  } finally {
    sub.unsubscribe();
  }
  if (!frames.some((frame) => frame.kind === "terminator")) throw new Error("raw prompt stream did not include zero-byte terminator");
  return { frames };
}

function describeFrame(msg: { data: Uint8Array; headers?: { get(name: string): string | null } | undefined }): RawFrame {
  const errorCode = msg.headers?.get("Nats-Service-Error-Code") ?? undefined;
  const errorDescription = msg.headers?.get("Nats-Service-Error") ?? undefined;
  if (!msg.headers && msg.data.length === 0) return { kind: "terminator", bytes: 0 };
  if (errorCode) return { kind: "error", bytes: msg.data.length, errorCode, ...(errorDescription ? { errorDescription } : {}), decoded: decodeBody(msg.data) };
  return { kind: "chunk", bytes: msg.data.length, decoded: decodeBody(msg.data) };
}

function assertErrorCode(frames: readonly RawFrame[], expectedCode: string, label: string): void {
  const error = frames.find((frame) => frame.kind === "error");
  if (error?.errorCode !== expectedCode) throw new Error(`${label}: expected ${expectedCode}, got ${error?.errorCode}`);
  if (!frames.some((frame) => frame.kind === "terminator")) throw new Error(`${label} missing terminator after error`);
}

function summarizeFrames(frames: readonly RawFrame[]): Array<Record<string, unknown>> {
  return frames.map((frame) => ({ kind: frame.kind, bytes: frame.bytes, ...(frame.errorCode ? { errorCode: frame.errorCode } : {}) }));
}

function decodeBody(data: Uint8Array): unknown {
  if (data.length === 0) return null;
  const text = decoder.decode(data);
  try { return JSON.parse(text); } catch { return text; }
}

async function startFakeManagerEndpoint(): Promise<{ socketPath: string; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "codex-manager-smoke-"));
  const socketPath = join(dir, "codex.sock");
  const threads = new Map<string, Record<string, unknown>>([
    ["thread-fixture-alpha", thread("thread-fixture-alpha")],
    ["thread-fixture-beta", thread("thread-fixture-beta")],
    ["thread-fixture-empty", { ...thread("thread-fixture-empty"), ephemeral: true, turns: [] }],
  ]);
  const server = createServer((socket) => serveJsonRpcSocket(socket, threads));
  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, resolve);
    server.once("error", reject);
  });
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function serveJsonRpcSocket(socket: Socket, threads: Map<string, Record<string, unknown>>): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let selectedThread = "thread-fixture-alpha";
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
      if (message.method === "initialize") send(socket, { id: message.id, result: { userAgent: "fake-manager/0.1", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" } });
      else if (message.method === "initialized") {}
      else if (message.method === "thread/loaded/list") send(socket, { id: message.id, result: { threads: [threads.get("thread-fixture-alpha"), threads.get("thread-fixture-beta"), threads.get("thread-fixture-empty")].filter(Boolean) } });
      else if (message.method === "thread/list") send(socket, { id: message.id, result: { threads: [...threads.values()].filter((value) => value.id !== "thread-fixture-empty") } });
      else if (message.method === "thread/read") {
        const row = threads.get(message.params.threadId);
        if (!row) send(socket, { id: message.id, error: { code: -32004, message: "thread not found" } });
        else send(socket, { id: message.id, result: { thread: row } });
      } else if (message.method === "thread/resume") {
        const row = threads.get(message.params.threadId);
        if (!row) send(socket, { id: message.id, error: { code: -32004, message: "thread not found" } });
        else { selectedThread = message.params.threadId; send(socket, { id: message.id, result: { thread: row, approvalPolicy: "never", approvalsReviewer: "user" } }); }
      } else if (message.method === "turn/start") {
        const threadId = selectedThread;
        const otherThread = threadId === "thread-fixture-alpha" ? "thread-fixture-beta" : "thread-fixture-alpha";
        const turnId = `turn-${nextTurn++}`;
        const text = message.params.input?.find((item: any) => item.type === "text")?.text ?? "";
        send(socket, { id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
        send(socket, { method: "agent/message/delta", params: { threadId: otherThread, turnId, delta: `noise from ${otherThread}` } });
        if (text.includes("explode")) {
          send(socket, { method: "error", params: { threadId, turnId, error: { message: "manager fake upstream failed" }, willRetry: false } });
        } else {
          send(socket, { method: "agent/message/delta", params: { threadId, turnId, delta: `response from ${threadId} to ${text}` } });
        }
        send(socket, { method: "turn/completed", params: { threadId, turnId, turn: { id: turnId, status: "completed" } } });
      } else send(socket, { id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    }
  });
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

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

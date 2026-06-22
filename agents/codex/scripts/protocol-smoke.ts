#!/usr/bin/env bun
import { createConnection, createServer } from "node:net";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type StreamMessage } from "@synadia-ai/agents";
import { FakeCodexBridgeClient } from "../src/bridge.js";
import type { CodexChannelConfig } from "../src/config.js";
import { createCodexAgentService } from "../src/service.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const name = `smoke-${Math.random().toString(36).slice(2, 8)}`;

const nats = await ensureNats();
const config: CodexChannelConfig = {
  nats: { url: nats.url },
  agent: {
    owner: "smoke",
    session: name,
    subjectToken: "codex",
    heartbeatIntervalS: 1,
    keepaliveIntervalS: 1,
  },
  codex: {
    mode: "fake",
    codexBin: "codex",
    permissionPolicy: "reject",
  },
  manager: {
    enabled: false,
    autoExposeCurrentSessions: false,
    autoExposeFutureSessions: false,
    watchMode: "event-plus-poll",
    watchIntervalMs: 7500,
    staleGraceIntervals: 3,
    exposeEphemeralLoadedSessions: false,
  },
};

const nc = await natsConnect({ servers: nats.url });
const callerNc = await natsConnect({ servers: nats.url });
const service = createCodexAgentService({
  nc,
  config,
  version: "0.1.0-smoke",
  client: new FakeCodexBridgeClient(),
});

const heartbeatSub = callerNc.subscribe(service.subject.heartbeat);

try {
  await callerNc.flush();
  await service.start();

  const rawInfo = await requestJson(callerNc, "$SRV.INFO.agents", "");
  if (!isRecord(rawInfo) || rawInfo.name !== "agents") throw new Error("$SRV.INFO.agents did not return the agents service");

  const agents = new Agents({ nc: callerNc });
  const found = await agents.discover({ timeoutMs: 1000, filter: { agent: "codex", name } });
  if (found.length !== 1) throw new Error(`expected one codex smoke agent, found ${found.length}`);
  const agent = found[0]!;

  assertEqual(agent.metadata["agent"], "codex", "service metadata agent");
  assertEqual(agent.metadata["owner"], "smoke", "service metadata owner");
  assertEqual(agent.metadata["session"], name, "service metadata session");
  assertEqual(agent.metadata["protocol_version"], "0.3", "service metadata protocol_version");
  assertEqual(agent.metadata["codex_mode"], "fake", "service metadata codex_mode");
  assertEqual(agent.metadata["permission_policy"], "reject", "service metadata permission_policy");
  assertEqual(agent.promptEndpoint.subject, service.subject.prompt, "prompt endpoint subject");
  assertEqual(agent.promptEndpoint.queueGroup, "agents", "prompt endpoint queue group");
  assertEqual(agent.promptEndpoint.attachmentsOk, false, "prompt endpoint attachments_ok");
  if (!agent.promptEndpoint.metadata["max_payload"]) throw new Error("prompt endpoint missing max_payload");
  const statusEndpoint = agent.endpoints.find((e) => e.name === "status");
  assertEqual(statusEndpoint?.subject, service.subject.status, "status endpoint subject");
  assertEqual(statusEndpoint?.queueGroup, "agents", "status endpoint queue group");

  const status = await requestJson(callerNc, service.subject.status, "");
  assertEqual(status["agent"], "codex", "status agent");
  assertEqual(status["owner"], "smoke", "status owner");
  assertEqual(status["session"], name, "status session");

  const heartbeat = await nextJson(heartbeatSub, 2500, "timed out waiting for heartbeat");
  assertEqual(heartbeat["agent"], "codex", "heartbeat agent");
  assertEqual(heartbeat["owner"], "smoke", "heartbeat owner");
  assertEqual(heartbeat["session"], name, "heartbeat session");

  const messages: StreamMessage[] = [];
  for await (const msg of await agent.prompt("hello smoke")) {
    messages.push(msg);
  }

  const first = messages[0];
  if (first?.type !== "status" || first.status !== "ack") throw new Error("missing leading ack status");
  if (!messages.some((m) => m.type === "status" && m.status.includes("Codex fake bridge selected"))) throw new Error("missing fake bridge status chunk");
  if (!messages.some((m) => m.type === "response" && m.text.includes("fake Codex response to hello smoke"))) throw new Error("missing fake Codex response chunk");
  const last = messages.at(-1);
  if (last?.type !== "status" || last.status !== "done") throw new Error("missing done terminator status");

  const rawSuccess = await rawPromptRoundTrip(callerNc, service.subject.prompt, "hello raw");
  assertRawSuccess(rawSuccess.frames);
  const rawJsonSuccess = await rawPromptRoundTrip(callerNc, service.subject.prompt, JSON.stringify({ prompt: "hello json envelope" }));
  assertRawSuccess(rawJsonSuccess.frames);
  const rawAttachment400 = await rawPromptRoundTrip(callerNc, service.subject.prompt, JSON.stringify({
    prompt: "attachment should be rejected",
    attachments: [{ filename: "note.txt", content: "QUJD" }],
  }));
  assertErrorCode(rawAttachment400.frames, "400", "unsupported attachment");
  const rawHandler500 = await rawPromptRoundTrip(callerNc, service.subject.prompt, "explode upstream");
  assertErrorCode(rawHandler500.frames, "500", "upstream handler failure");

  console.log(JSON.stringify({
    natsUrl: nats.url,
    srvInfo: { name: rawInfo.name, version: rawInfo.version, metadata: rawInfo.metadata },
    subject: service.subject.prompt,
    status: service.subject.status,
    heartbeat: service.subject.heartbeat,
    metadata: agent.metadata,
    promptEndpoint: agent.promptEndpoint,
    statusPayload: summarizeStatus(status),
    heartbeatPayload: summarizeStatus(heartbeat),
    sdkClientMessageTypes: messages.map((m) => m.type),
    sdkClientLastMessage: last,
    rawWire: {
      plainTextSuccess: summarizeFrames(rawSuccess.frames),
      jsonNoAttachmentSuccess: summarizeFrames(rawJsonSuccess.frames),
      unsupportedAttachment400: summarizeFrames(rawAttachment400.frames),
      handlerFailure500: summarizeFrames(rawHandler500.frames),
    },
  }, null, 2));
} finally {
  heartbeatSub.unsubscribe();
  await service.stop();
  await nc.drain();
  await callerNc.drain();
  await nats.close();
}

interface RawFrame {
  readonly kind: "chunk" | "error" | "terminator";
  readonly bytes: number;
  readonly errorCode?: string;
  readonly errorDescription?: string;
  readonly decoded?: unknown;
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

async function rawPromptRoundTrip(callerNc: typeof nc, subject: string, payload: string): Promise<{ frames: RawFrame[] }> {
  const reply = `_INBOX.codex-raw-${Math.random().toString(36).slice(2, 8)}`;
  const sub = callerNc.subscribe(reply);
  const frames: RawFrame[] = [];
  await callerNc.flush();
  callerNc.publish(subject, encoder.encode(payload), { reply });
  const iterator = sub[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await withTimeout(iterator.next(), 5000, `timed out waiting for raw protocol frames on ${reply}`);
      if (result.done) break;
      const msg = result.value;
      const frame = describeFrame(msg);
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
  if (errorCode) {
    return {
      kind: "error",
      bytes: msg.data.length,
      errorCode,
      ...(errorDescription ? { errorDescription } : {}),
      decoded: decodeBody(msg.data),
    };
  }
  return { kind: "chunk", bytes: msg.data.length, decoded: decodeBody(msg.data) };
}

function decodeBody(data: Uint8Array): unknown {
  if (data.length === 0) return null;
  const text = decoder.decode(data);
  try { return JSON.parse(text); } catch { return text; }
}

function assertRawSuccess(frames: readonly RawFrame[]): void {
  const chunks = frames.filter((frame) => frame.kind === "chunk");
  const first = chunks[0]?.decoded;
  if (!isRecord(first) || first.type !== "status" || first.data !== "ack") throw new Error("raw success missing leading ack chunk");
  if (!chunks.some((frame) => isWireChunk(frame.decoded, "status", "Codex fake bridge selected"))) throw new Error("raw success missing bridge status chunk");
  if (!chunks.some((frame) => isWireChunk(frame.decoded, "response", "fake Codex response"))) throw new Error("raw success missing response chunk");
  if (!frames.some((frame) => frame.kind === "terminator")) throw new Error("raw success missing terminator");
}

function assertErrorCode(frames: readonly RawFrame[], expectedCode: string, label: string): void {
  const error = frames.find((frame) => frame.kind === "error");
  assertEqual(error?.errorCode, expectedCode, `${label} error code`);
  if (!frames.some((frame) => frame.kind === "terminator")) throw new Error(`${label} missing terminator after error`);
}

function isWireChunk(decoded: unknown, type: string, dataIncludes: string): boolean {
  return isRecord(decoded) && decoded.type === type && typeof decoded.data === "string" && decoded.data.includes(dataIncludes);
}

function summarizeFrames(frames: readonly RawFrame[]): Array<Record<string, unknown>> {
  return frames.map((frame) => {
    const out: Record<string, unknown> = { kind: frame.kind, bytes: frame.bytes };
    if (frame.errorCode) out.errorCode = frame.errorCode;
    if (frame.errorDescription) out.errorDescription = frame.errorDescription;
    if (isRecord(frame.decoded)) {
      out.type = frame.decoded.type;
      if (typeof frame.decoded.data === "string") out.data = frame.decoded.data;
    } else if (typeof frame.decoded === "string") {
      out.data = frame.decoded;
    }
    return out;
  });
}

function summarizeStatus(value: Record<string, unknown>): Record<string, unknown> {
  return {
    agent: value.agent,
    owner: value.owner,
    session: value.session,
    interval_s: value.interval_s,
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function ensureNats(): Promise<{ url: string; close(): Promise<void> }> {
  if (process.env["CODEX_SMOKE_USE_EXTERNAL_NATS"] === "1" && process.env["NATS_URL"]) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

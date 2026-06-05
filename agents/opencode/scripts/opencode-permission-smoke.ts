#!/usr/bin/env bun
import { createConnection, createServer } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { connect as natsConnect } from "@nats-io/transport-node";
import type { OpenCodeChannelConfig } from "../src/config.js";
import { createOpenCodeClient } from "../src/opencode-client.js";
import { createOpenCodeAgentService } from "../src/service.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_ENV_FILE = join(resolveUserHome(), ".hermes", "projects", "synadia-agents-opencode", "secrets", "opencode-openrouter.env");
const envFile = process.env["OPENCODE_TEST_ENV_FILE"] ?? DEFAULT_ENV_FILE;
const loaded = loadScopedEnv(envFile);
const model = process.env["OPENCODE_TEST_MODEL"];
if (!process.env["OPENROUTER_API_KEY"]) throw new Error(`${envFile} did not provide OPENROUTER_API_KEY`);
if (!model) throw new Error(`${envFile} did not provide OPENCODE_TEST_MODEL`);

const nats = await ensureNats();
const name = `permission-${Math.random().toString(36).slice(2, 8)}`;
const harnessDir = mkdtempSync(join(tmpdir(), "opencode-permission-smoke-"));
const targetFile = join(harnessDir, "delete-me.txt");
writeFileSync(targetFile, "OpenCode permission smoke target\n", "utf8");
const opencodePort = await freePort();

const config: OpenCodeChannelConfig = {
  nats: { url: nats.url },
  agent: { owner: "smoke", name, subjectToken: "opencode", heartbeatIntervalS: 1, keepaliveIntervalS: 1 },
  opencode: {
    mode: "managed",
    hostname: "127.0.0.1",
    port: opencodePort,
    directory: harnessDir,
    model,
    permissionPolicy: "query",
    permissionTimeoutMs: 120000,
  },
};

const nc = await natsConnect({ servers: nats.url });
const callerNc = await natsConnect({ servers: nats.url });
const client = await createOpenCodeClient(config);
const service = createOpenCodeAgentService({ nc, config, version: "0.1.0-permission-smoke", client });
let output: Record<string, unknown> | undefined;
try {
  await service.start();
  const prompt = `This is a scoped permission-capability test harness. Only operate inside this exact directory: ${harnessDir}. Use the bash/shell tool to remove exactly this file and nothing else: ${targetFile}. Do not remove the directory. If permission is requested, wait for the harness decision.`;
  const targetExistsBefore = existsSync(targetFile);
  const roundTrip = await rawPromptRoundTrip(callerNc, service.subject.prompt, prompt, "no");
  const targetExistsAfterDeny = existsSync(targetFile);
  if (!targetExistsBefore) throw new Error("target file was missing before prompt");
  if (!targetExistsAfterDeny) throw new Error("target file was removed even though the protocol query replied no");
  const queryFrame = roundTrip.frames.find((frame) => isRecord(frame.decoded) && frame.decoded.type === "query");
  const queryPrompt = readQueryPrompt(queryFrame?.decoded);
  if (!queryPrompt) throw new Error("real OpenCode run did not emit a protocol query chunk");
  if (!queryPrompt.includes("OpenCode permission id:")) throw new Error(`query prompt did not include OpenCode permission id evidence: ${queryPrompt}`);
  const rejectedSeen = roundTrip.frames.some((frame) => isWireChunk(frame.decoded, "status", "Rejected by protocol query reply"));
  if (!rejectedSeen) {
    throw new Error("stream did not include permission rejection status after deny reply");
  }
  output = {
    envFile,
    loadedKeys: loaded,
    model,
    natsUrl: nats.url,
    subject: service.subject.prompt,
    opencodeMode: client.mode,
    harnessDir,
    targetFile,
    targetExistsBefore,
    targetExistsAfterDeny,
    permissionQueryPrompt: queryPrompt,
    permissionQueryPromptIncludesTarget: queryPrompt.includes(targetFile),
    queryReplySubject: readQueryReplySubject(queryFrame?.decoded),
    queryReplySent: "no",
    rejectedSeen,
    responseText: collectResponseText(roundTrip.frames),
    rawWire: summarizeFrames(roundTrip.frames),
    keptHarnessDir: process.env["OPENCODE_PERMISSION_SMOKE_KEEP"] === "1",
  };
  console.log(JSON.stringify(output, null, 2));
} finally {
  await service.stop();
  await client.close?.();
  await nc.close();
  await callerNc.close();
  await nats.close();
  if (process.env["OPENCODE_PERMISSION_SMOKE_KEEP"] !== "1") rmSync(harnessDir, { recursive: true, force: true });
}

if (output) {
  await Bun.sleep(50);
  process.exit(0);
}

interface RawFrame {
  readonly kind: "chunk" | "error" | "terminator";
  readonly bytes: number;
  readonly errorCode?: string;
  readonly errorDescription?: string;
  readonly decoded?: unknown;
}

async function rawPromptRoundTrip(
  callerNc: typeof nc,
  subject: string,
  payload: string,
  queryReply: string,
): Promise<{ frames: RawFrame[] }> {
  const reply = `_INBOX.opencode-permission-${Math.random().toString(36).slice(2, 8)}`;
  const sub = callerNc.subscribe(reply);
  const frames: RawFrame[] = [];
  await callerNc.flush();
  callerNc.publish(subject, encoder.encode(payload), { reply });
  const iterator = sub[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await withTimeout(iterator.next(), 180000, `timed out waiting for permission smoke frames on ${reply}`);
      if (result.done) break;
      const msg = result.value;
      const frame = describeFrame(msg);
      frames.push(frame);
      const queryReplySubject = readQueryReplySubject(frame.decoded);
      if (queryReplySubject) callerNc.publish(queryReplySubject, encoder.encode(queryReply));
      if (frame.kind === "terminator") break;
    }
  } finally {
    sub.unsubscribe();
  }
  if (!frames.some((frame) => frame.kind === "terminator")) throw new Error("permission smoke stream did not include zero-byte terminator");
  if (frames.some((frame) => frame.kind === "error")) throw new Error(`permission smoke stream returned service error: ${JSON.stringify(summarizeFrames(frames))}`);
  return { frames };
}

function describeFrame(msg: { data: Uint8Array; headers?: { get(name: string): string | null } | undefined }): RawFrame {
  const errorCode = msg.headers?.get("Nats-Service-Error-Code") ?? undefined;
  const errorDescription = msg.headers?.get("Nats-Service-Error") ?? undefined;
  if (!msg.headers && msg.data.length === 0) return { kind: "terminator", bytes: 0 };
  if (errorCode) {
    return { kind: "error", bytes: msg.data.length, errorCode, ...(errorDescription ? { errorDescription } : {}), decoded: decodeBody(msg.data) };
  }
  return { kind: "chunk", bytes: msg.data.length, decoded: decodeBody(msg.data) };
}

function decodeBody(data: Uint8Array): unknown {
  if (data.length === 0) return null;
  const text = decoder.decode(data);
  try { return JSON.parse(text); } catch { return text; }
}

function readQueryReplySubject(decoded: unknown): string | undefined {
  if (!isRecord(decoded) || decoded.type !== "query" || !isRecord(decoded.data)) return undefined;
  return typeof decoded.data.reply_subject === "string" ? decoded.data.reply_subject : undefined;
}

function readQueryPrompt(decoded: unknown): string | undefined {
  if (!isRecord(decoded) || decoded.type !== "query" || !isRecord(decoded.data)) return undefined;
  return typeof decoded.data.prompt === "string" ? decoded.data.prompt : undefined;
}

function isWireChunk(decoded: unknown, type: string, dataIncludes: string): boolean {
  return isRecord(decoded) && decoded.type === type && typeof decoded.data === "string" && decoded.data.includes(dataIncludes);
}

function collectResponseText(frames: readonly RawFrame[]): string {
  return frames
    .map((frame) => isRecord(frame.decoded) && frame.decoded.type === "response" && typeof frame.decoded.data === "string" ? frame.decoded.data : "")
    .join("");
}

function summarizeFrames(frames: readonly RawFrame[]): Array<Record<string, unknown>> {
  return frames.map((frame) => {
    const out: Record<string, unknown> = { kind: frame.kind, bytes: frame.bytes };
    if (frame.errorCode) out.errorCode = frame.errorCode;
    if (frame.errorDescription) out.errorDescription = frame.errorDescription;
    if (isRecord(frame.decoded)) {
      out.type = frame.decoded.type;
      if (typeof frame.decoded.data === "string") out.data = frame.decoded.data;
      if (isRecord(frame.decoded.data) && typeof frame.decoded.data.prompt === "string") out.prompt = frame.decoded.data.prompt;
      if (isRecord(frame.decoded.data) && typeof frame.decoded.data.reply_subject === "string") out.reply_subject = frame.decoded.data.reply_subject;
    } else if (typeof frame.decoded === "string") {
      out.data = frame.decoded;
    }
    return out;
  });
}

async function ensureNats(): Promise<{ url: string; close(): Promise<void> }> {
  if (process.env["OPENCODE_SMOKE_USE_EXTERNAL_NATS"] === "1" && process.env["NATS_URL"]) {
    return { url: process.env["NATS_URL"], close: async () => {} };
  }
  const port = await freePort();
  const url = `nats://127.0.0.1:${port}`;
  const proc = Bun.spawn(["nats-server", "-a", "127.0.0.1", "-p", String(port)], { stdout: "ignore", stderr: "pipe" });
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

function loadScopedEnv(path: string): string[] {
  if (!existsSync(path)) throw new Error(`scoped OpenCode test env file does not exist: ${path}`);
  const allowed = new Set(["OPENROUTER_API_KEY", "OPENCODE_TEST_MODEL"]);
  const loaded: string[] = [];
  chmodSync(path, 0o600);
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) throw new Error(`invalid scoped env line for ${path}; expected KEY=VALUE`);
    const key = match[1]!;
    if (!allowed.has(key)) throw new Error(`refusing to load unexpected scoped env key ${key} from ${path}`);
    process.env[key] = (match[2] ?? "").replace(/^[\"']|[\"']$/g, "");
    loaded.push(key);
  }
  return loaded;
}

function resolveUserHome(): string {
  const home = homedir();
  const marker = `${sep}.hermes${sep}profiles${sep}`;
  const markerIndex = home.indexOf(marker);
  if (markerIndex >= 0) return home.slice(0, markerIndex);
  return home;
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
        const socket = createConnection({ host: "127.0.0.1", port }, () => { socket.end(); resolve(); });
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

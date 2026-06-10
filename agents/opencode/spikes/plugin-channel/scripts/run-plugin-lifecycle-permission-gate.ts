#!/usr/bin/env bun
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const packageRoot = resolve(import.meta.dir, "../../..");
const spikeRoot = resolve(import.meta.dir, "..");

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

async function main(): Promise<void> {
  const artifactDir = process.env.SPIKE_ARTIFACT_DIR ?? join(tmpdir(), `opencode-plugin-lifecycle-permission-${timestamp()}`);
  mkdirSync(artifactDir, { recursive: true });

  const projectDir = mkdtempSync(join(tmpdir(), "opencode-plugin-gate-project-"));
  const opencodeDir = join(projectDir, ".opencode");
  const pluginDir = join(opencodeDir, "plugins");
  mkdirSync(pluginDir, { recursive: true });

  const coreSrc = join(spikeRoot, "src", "synadia-channel-core.ts");
  const pluginSrc = join(spikeRoot, "src", "synadia-channel-plugin.ts");
  const coreDest = join(opencodeDir, "synadia-channel-core.ts");
  const pluginDest = join(pluginDir, "synadia-channel-plugin.ts");
  copyFileSync(coreSrc, coreDest);
  const pluginBody = readFileSync(pluginSrc, "utf8").replace("./synadia-channel-core.ts", "../synadia-channel-core.ts");
  writeFileSync(pluginDest, pluginBody);
  writeFileSync(join(pluginDir, "synadia-channel-plugin-duplicate.ts"), pluginBody.replace("SynadiaChannelPlugin", "SynadiaChannelPluginDuplicate"));
  writeFileSync(join(projectDir, "README.md"), "# Generic OpenCode lifecycle permission gate project\n\nNo private project names here.\n");

  const natsPort = await freePort();
  const ocPort = await freePort();
  const fakeProviderPort = await freePort();
  const natsUrl = `nats://127.0.0.1:${natsPort}`;
  const fakeProviderUrl = `http://127.0.0.1:${fakeProviderPort}/v1`;
  const pluginLog = join(artifactDir, "plugin.ndjson");
  const opencodeLog = join(artifactDir, "opencode.log");
  const opencodeRestartLog = join(artifactDir, "opencode-restart.log");
  const natsLog = join(artifactDir, "nats-server.log");
  const fakeProviderLog = join(artifactDir, "fake-provider.ndjson");
  const resultPath = join(artifactDir, "result.json");
  const owner = "spike-owner";
  const session = "spike-session";
  const model = { providerID: "synadia-fake", modelID: "tool-model" };

  writeFileSync(join(opencodeDir, "package.json"), JSON.stringify({
    type: "module",
    dependencies: {
      "@nats-io/nats-core": "^3.4.0",
      "@nats-io/transport-node": "^3.4.0",
      "@synadia-ai/agents": `file:${join(packageRoot, "node_modules", "@synadia-ai", "agents")}`,
      "@synadia-ai/agent-service": `file:${join(packageRoot, "node_modules", "@synadia-ai", "agent-service")}`,
    },
  }, null, 2));
  writeFileSync(join(opencodeDir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["synadia-fake"],
    provider: {
      "synadia-fake": {
        npm: "@ai-sdk/openai-compatible",
        name: "Synadia deterministic fake provider",
        options: { baseURL: fakeProviderUrl, apiKey: "not-a-real-secret" },
        models: {
          "tool-model": {
            name: "Tool model",
            tool_call: true,
            limit: { context: 128000, output: 4096 },
          },
        },
      },
    },
    permission: {
      bash: "ask",
      edit: "ask",
      external_directory: "ask",
      webfetch: "ask",
    },
  }, null, 2));

  const fakeProvider = await startFakeProvider(fakeProviderPort, fakeProviderLog);
  const nats = Bun.spawn(["nats-server", "-a", "127.0.0.1", "-p", String(natsPort), "-js", "--store_dir", join(projectDir, "nats-store")], {
    stdout: Bun.file(natsLog),
    stderr: Bun.file(natsLog),
  });
  await waitFor(async () => isTcpOpen(natsPort), 10_000, "nats-server ready");

  const opencode = startOpenCode(projectDir, ocPort, natsUrl, pluginLog, opencodeLog, owner, session);
  let nc: Awaited<ReturnType<typeof natsConnect>> | undefined;
  let callerNc: Awaited<ReturnType<typeof natsConnect>> | undefined;
  let opencode2: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await waitFor(async () => isTcpOpen(ocPort), 10_000, "opencode serve ready");
    const createdSessionId = await createSessionWithRetry(ocPort, projectDir, 15_000);
    await waitFor(() => countLog(pluginLog, "nats service registered") === 1, 90_000, "single plugin NATS registration");
    await waitFor(() => countLog(pluginLog, "duplicate initialization reused existing channel") >= 1, 30_000, "duplicate plugin init guard");

    nc = await natsConnect({ servers: natsUrl });
    callerNc = await natsConnect({ servers: natsUrl });
    const agents = new Agents({ nc });
    const found = await agents.discover({ timeoutMs: 2_000, filter: { agent: "opencode", owner, name: session } });
    if (found.length !== 1) throw new Error(`expected one registered plugin agent after duplicate init, found ${found.length}`);
    const agent = found[0]!;

    const promptPromise = rawPromptRoundTrip(callerNc, agent.promptEndpoint.subject, {
      prompt: "hold_for_permission_probe: bridge the next real OpenCode tool permission to this Synadia prompt",
      opencode_session_id: createdSessionId,
    }, "always");
    await waitFor(() => logContains(pluginLog, "permission probe prompt active"), 10_000, "active Synadia permission prompt");

    const toolPromptStatus = await triggerToolPermission(ocPort, projectDir, createdSessionId, model);
    const roundTrip = await promptPromise;
    const permissionQuery = roundTrip.frames.find((frame) => isQueryFrame(frame.decoded));
    const queryPrompt = readQueryPrompt(permissionQuery?.decoded);
    if (!queryPrompt) throw new Error(`Synadia prompt stream did not include a protocol query frame: ${JSON.stringify(summarizeFrames(roundTrip.frames))}`);
    if (!queryPrompt.includes("OpenCode requests permission")) throw new Error(`query prompt missing permission text: ${queryPrompt}`);
    if (!queryPrompt.includes("synadia-permission-probe")) throw new Error(`query prompt missing deterministic tool pattern evidence: ${queryPrompt}`);
    if (!roundTrip.frames.some((frame) => isWireChunk(frame.decoded, "response", "plugin permission bridge complete"))) {
      throw new Error(`prompt stream missing permission bridge completion response: ${JSON.stringify(summarizeFrames(roundTrip.frames))}`);
    }
    await waitFor(() => logContains(pluginLog, "permission event bridged"), 10_000, "permission bridge log");
    await waitFor(() => logContains(pluginLog, "permission.replied"), 10_000, "permission replied event");

    await stopProcess(opencode, "SIGINT");
    const disposeObservedAfterStop = await waitForOptional(() => logContains(pluginLog, "dispose complete"), 5_000);
    const foundAfterStop = await discoverOrEmpty(agents, { timeoutMs: 1_000, filter: { agent: "opencode", owner, name: session } });

    opencode2 = startOpenCode(projectDir, ocPort, natsUrl, pluginLog, opencodeRestartLog, owner, session);
    await waitFor(async () => isTcpOpen(ocPort), 10_000, "opencode restart ready");
    await createSessionWithRetry(ocPort, projectDir, 15_000);
    await waitFor(() => countLog(pluginLog, "nats service registered") >= 2, 60_000, "plugin restart registration");
    const foundAfterRestart = await agents.discover({ timeoutMs: 2_000, filter: { agent: "opencode", owner, name: session } });
    if (foundAfterRestart.length !== 1) throw new Error(`expected one registered plugin agent after restart, found ${foundAfterRestart.length}`);
    await stopProcess(opencode2, "SIGINT");
    const disposeObservedAfterRestart = await waitForOptional(() => countLog(pluginLog, "dispose complete") >= 2, 5_000);

    const result = {
      ok: true,
      versions: { opencode: "1.17.1 via npx opencode-ai@1.17.1" },
      artifactDir,
      projectDir,
      natsUrl,
      opencodeUrl: `http://127.0.0.1:${ocPort}`,
      fakeProviderUrl,
      subject: agent.promptEndpoint.subject,
      promptEndpoint: agent.promptEndpoint,
      metadata: agent.metadata,
      lifecycle: {
        duplicatePluginFiles: 2,
        registrationCountBeforeRestart: 1,
        duplicateInitGuardCount: countLog(pluginLog, "duplicate initialization reused existing channel"),
        foundAfterDuplicateInit: found.length,
        foundAfterStop: foundAfterStop.length,
        foundAfterRestart: foundAfterRestart.length,
        disposeCompleteCount: countLog(pluginLog, "dispose complete"),
        disposeObservedAfterStop,
        disposeObservedAfterRestart,
      },
      permissionBridge: {
        sessionId: createdSessionId,
        toolPromptStatus,
        queryPrompt,
        queryReplySent: "always",
        queryReplySubject: readQueryReplySubject(permissionQuery?.decoded),
        permissionBridgeCount: countLog(pluginLog, "permission event bridged"),
        permissionRepliedCount: countLog(pluginLog, "permission.replied"),
        eventTypes: summarizePluginEvents(pluginLog),
        rawWire: summarizeFrames(roundTrip.frames),
        fakeProviderRequests: fakeProvider.requestCount(),
      },
      cleanup: {
        fullProcessRestartDuplicateRegistration: foundAfterRestart.length !== 1,
        managerReconcilerFallbackPreserved: true,
        conclusion: disposeObservedAfterStop || disposeObservedAfterRestart
          ? "OpenCode dispose observed on SIGINT in this run; keep manager reconciler until repeated runs prove reliability."
          : "OpenCode serve SIGINT exited without plugin dispose; plugin registration is safe via process death/restart and singleton guard, but manager reconciler fallback remains required for stale lifecycle recovery.",
      },
      logs: { pluginLog, opencodeLog, opencodeRestartLog, natsLog, fakeProviderLog },
    };
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await callerNc?.close();
    await nc?.close();
    if (!opencode.killed) await stopProcess(opencode, "SIGTERM").catch(() => undefined);
    if (opencode2 && !opencode2.killed) await stopProcess(opencode2, "SIGTERM").catch(() => undefined);
    if (!nats.killed) await stopProcess(nats, "SIGTERM").catch(() => undefined);
    await fakeProvider.close();
    if (process.env.KEEP_SPIKE_PROJECT !== "1") rmSync(projectDir, { recursive: true, force: true });
  }
}

function startOpenCode(projectDir: string, port: number, natsUrl: string, pluginLog: string, logPath: string, owner: string, session: string) {
  return Bun.spawn(["zsh", "-lic", `npx --yes opencode-ai@1.17.1 serve --hostname 127.0.0.1 --port ${port} --print-logs --log-level DEBUG`], {
    cwd: projectDir,
    env: {
      ...process.env,
      SYNADIA_NATS_URL: natsUrl,
      SYNADIA_PLUGIN_LOG: pluginLog,
      SYNADIA_OWNER: owner,
      SYNADIA_SESSION: session,
    },
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
  });
}

async function createSessionWithRetry(port: number, projectDir: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await createSession(port, projectDir);
    } catch (err) {
      lastError = err;
      await delay(250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`timed out creating OpenCode session: ${String(lastError)}`);
}

async function createSession(port: number, projectDir: string): Promise<string> {
  const created = await fetch(`http://127.0.0.1:${port}/session?directory=${encodeURIComponent(projectDir)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  const text = await created.text();
  if (!created.ok) throw new Error(`POST /session failed ${created.status}: ${text}`);
  const sessionId = sessionIdFromBody(text);
  if (!sessionId) throw new Error(`POST /session response missing id: ${text}`);
  return sessionId;
}

async function triggerToolPermission(port: number, projectDir: string, sessionId: string, model: { providerID: string; modelID: string }): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/session/${sessionId}/message?directory=${encodeURIComponent(projectDir)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      tools: { synadia_permission_probe: true },
      parts: [{ type: "text", text: "Call the synadia_permission_probe tool exactly once, then stop." }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /session/:id/message tool prompt failed ${res.status}: ${text}`);
  return res.status;
}

interface RawFrame {
  readonly kind: "chunk" | "error" | "terminator";
  readonly bytes: number;
  readonly errorCode?: string;
  readonly errorDescription?: string;
  readonly decoded?: unknown;
}

async function rawPromptRoundTrip(
  callerNc: Awaited<ReturnType<typeof natsConnect>>,
  subject: string,
  payload: Record<string, unknown>,
  queryReply: string,
): Promise<{ frames: RawFrame[] }> {
  const reply = `_INBOX.opencode-plugin-gate-${Math.random().toString(36).slice(2, 8)}`;
  const sub = callerNc.subscribe(reply);
  const frames: RawFrame[] = [];
  await callerNc.flush();
  callerNc.publish(subject, encoder.encode(JSON.stringify(payload)), { reply });
  const iterator = sub[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await withTimeout(iterator.next(), 45_000, `timed out waiting for prompt frames on ${reply}`);
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
  if (!frames.some((frame) => frame.kind === "terminator")) throw new Error("prompt stream did not include zero-byte terminator");
  if (frames.some((frame) => frame.kind === "error")) throw new Error(`prompt stream returned service error: ${JSON.stringify(summarizeFrames(frames))}`);
  return { frames };
}

function describeFrame(msg: { data: Uint8Array; headers?: { get(name: string): string | null } | undefined }): RawFrame {
  const errorCode = msg.headers?.get("Nats-Service-Error-Code") ?? undefined;
  const errorDescription = msg.headers?.get("Nats-Service-Error") ?? undefined;
  if (!msg.headers && msg.data.length === 0) return { kind: "terminator", bytes: 0 };
  if (errorCode) return { kind: "error", bytes: msg.data.length, errorCode, ...(errorDescription ? { errorDescription } : {}), decoded: decodeBody(msg.data) };
  return { kind: "chunk", bytes: msg.data.length, decoded: decodeBody(msg.data) };
}

function decodeBody(data: Uint8Array): unknown {
  if (data.length === 0) return null;
  const text = decoder.decode(data);
  try { return JSON.parse(text); } catch { return text; }
}

function isQueryFrame(decoded: unknown): boolean {
  return isRecord(decoded) && decoded.type === "query";
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

async function startFakeProvider(port: number, logPath: string): Promise<{ close(): Promise<void>; requestCount: () => number }> {
  let chatRequests = 0;
  let toolCallSent = false;
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/v1/models") {
      writeLog(logPath, { type: "models" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "tool-model", object: "model", created: 0, owned_by: "synadia" }] }));
      return;
    }
    if (req.method === "POST" && url === "/v1/chat/completions") {
      chatRequests += 1;
      const bodyText = await readRequest(req);
      const safeBody = safeProviderBody(bodyText);
      writeLog(logPath, { type: "chat", chatRequests, body: safeBody });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const shouldCallPermissionTool = !toolCallSent && Array.isArray(safeBody.tools) && safeBody.tools.includes("synadia_permission_probe");
      if (shouldCallPermissionTool) {
        toolCallSent = true;
        sendSse(res, { id: "chatcmpl-tool", object: "chat.completion.chunk", created: 0, model: "tool-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_synadia_permission_probe", type: "function", function: { name: "synadia_permission_probe", arguments: "{}" } }] }, finish_reason: null }] });
        sendSse(res, { id: "chatcmpl-tool", object: "chat.completion.chunk", created: 0, model: "tool-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        sendSse(res, { id: "chatcmpl-final", object: "chat.completion.chunk", created: 0, model: "tool-model", choices: [{ index: 0, delta: { role: "assistant", content: "permission probe complete" }, finish_reason: null }] });
        sendSse(res, { id: "chatcmpl-final", object: "chat.completion.chunk", created: 0, model: "tool-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    writeLog(logPath, { type: "unexpected", method: req.method, url });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${url}` } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
    requestCount: () => chatRequests,
  };
}

function sendSse(res: { write(chunk: string): unknown }, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readRequest(req: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function safeProviderBody(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return {
      model: parsed.model,
      stream: parsed.stream,
      toolChoice: parsed.tool_choice,
      tools: Array.isArray(parsed.tools) ? parsed.tools.map((tool: Record<string, unknown>) => isRecord(tool.function) ? tool.function.name : tool.type) : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages.map((message: Record<string, unknown>) => ({ role: message.role, contentType: typeof message.content, tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls.length : undefined })) : [],
    };
  } catch {
    return { unparsable: true, bytes: text.length };
  }
}

function writeLog(path: string, row: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, { flag: "a" });
}

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function isTcpOpen(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(s) { s.end(); } } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForOptional(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await delay(250);
  }
  return false;
}

function logContains(path: string, needle: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes(needle);
}

function countLog(path: string, needle: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split(needle).length - 1;
}

async function stopProcess(proc: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals): Promise<void> {
  if (proc.killed) return;
  proc.kill(signal);
  await Promise.race([proc.exited.catch(() => undefined), delay(5_000)]);
  if (!proc.killed) proc.kill("SIGKILL");
}

async function discoverOrEmpty(agents: Agents, input: Parameters<Agents["discover"]>[0]) {
  try {
    return await agents.discover(input);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no responders")) return [];
    throw err;
  }
}

function sessionIdFromBody(text: string): string | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && typeof value.id === "string" ? value.id : undefined;
  } catch {
    return undefined;
  }
}

function summarizePluginEvents(path: string): Record<string, number> {
  const events: Record<string, number> = {};
  if (!existsSync(path)) return events;
  for (const line of readFileSync(path, "utf8").split(/\n+/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.message === "event observed" && typeof row.type === "string") events[row.type] = (events[row.type] ?? 0) + 1;
    } catch {
      // ignore partial log line
    }
  }
  return events;
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

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const packageRoot = resolve(import.meta.dir, "../../..");
const spikeRoot = resolve(import.meta.dir, "..");

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

async function main(): Promise<void> {
  const artifactDir = process.env.SPIKE_ARTIFACT_DIR ?? join(tmpdir(), `opencode-plugin-spike-${timestamp()}`);
  mkdirSync(artifactDir, { recursive: true });

  const projectDir = mkdtempSync(join(tmpdir(), "opencode-plugin-spike-project-"));
  const opencodeDir = join(projectDir, ".opencode");
  const pluginDir = join(opencodeDir, "plugins");
  mkdirSync(pluginDir, { recursive: true });

  const coreSrc = join(spikeRoot, "src", "synadia-channel-core.ts");
  const pluginSrc = join(spikeRoot, "src", "synadia-channel-plugin.ts");
  const coreDest = join(opencodeDir, "synadia-channel-core.ts");
  const pluginDest = join(pluginDir, "synadia-channel-plugin.ts");
  copyFileSync(coreSrc, coreDest);
  writeFileSync(pluginDest, readFileSync(pluginSrc, "utf8").replace("./synadia-channel-core.ts", "../synadia-channel-core.ts"));
  writeFileSync(join(projectDir, "README.md"), "# Generic OpenCode plugin spike project\n\nNo private project names here.\n");
  writeFileSync(join(opencodeDir, "package.json"), JSON.stringify({
    type: "module",
    dependencies: {
      "@nats-io/nats-core": "^3.4.0",
      "@nats-io/transport-node": "^3.4.0",
      "@synadia-ai/agents": `file:${join(packageRoot, "node_modules", "@synadia-ai", "agents")}`,
      "@synadia-ai/agent-service": `file:${join(packageRoot, "node_modules", "@synadia-ai", "agent-service")}`,
    },
  }, null, 2));

  const natsPort = await freePort();
  const ocPort = await freePort();
  const natsUrl = `nats://127.0.0.1:${natsPort}`;
  const pluginLog = join(artifactDir, "plugin.ndjson");
  const opencodeLog = join(artifactDir, "opencode.log");
  const natsLog = join(artifactDir, "nats-server.log");
  const resultPath = join(artifactDir, "result.json");
  const owner = "spike-owner";
  const session = "spike-session";

  const nats = Bun.spawn(["nats-server", "-p", String(natsPort), "-js", "--store_dir", join(projectDir, "nats-store")], {
    stdout: Bun.file(natsLog),
    stderr: Bun.file(natsLog),
  });
  await waitFor(async () => isTcpOpen(natsPort), 10_000, "nats-server ready");

  const opencode = Bun.spawn(["zsh", "-lic", `npx --yes opencode-ai@1.17.1 serve --hostname 127.0.0.1 --port ${ocPort} --print-logs --log-level DEBUG`], {
    cwd: projectDir,
    env: {
      ...process.env,
      SYNADIA_NATS_URL: natsUrl,
      SYNADIA_PLUGIN_LOG: pluginLog,
      SYNADIA_OWNER: owner,
      SYNADIA_SESSION: session,
    },
    stdout: Bun.file(opencodeLog),
    stderr: Bun.file(opencodeLog),
  });

  let nc: Awaited<ReturnType<typeof natsConnect>> | undefined;
  try {
    await waitFor(async () => isTcpOpen(ocPort), 10_000, "opencode serve ready");
    const created = await fetch(`http://127.0.0.1:${ocPort}/session?directory=${encodeURIComponent(projectDir)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
    const createdText = await created.text();
    if (!created.ok) throw new Error(`POST /session failed ${created.status}: ${createdText}`);
    await waitFor(() => logContains(pluginLog, "nats service registered"), 90_000, "OpenCode plugin NATS registration");
    await waitFor(() => logContains(pluginLog, "session.created"), 10_000, "session.created plugin event");
    const createdSessionId = sessionIdFromBody(createdText);
    if (!createdSessionId) throw new Error(`POST /session response missing id: ${createdText}`);
    const message = await fetch(`http://127.0.0.1:${ocPort}/session/${createdSessionId}/message?directory=${encodeURIComponent(projectDir)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: "observe message event without model call" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const messageText = await message.text();
    if (!message.ok) throw new Error(`POST /session/:id/message failed ${message.status}: ${messageText}`);
    await waitFor(() => logContains(pluginLog, "message.updated") || logContains(pluginLog, "message.part.updated"), 10_000, "message plugin event");

    nc = await natsConnect({ servers: natsUrl });
    const agents = new Agents({ nc });
    const found = await agents.discover({ timeoutMs: 2_000, filter: { agent: "opencode", owner, name: session } });
  if (found.length !== 1) throw new Error(`expected one registered plugin agent, found ${found.length}`);
  const agent = found[0]!;
  const messages: Array<Record<string, unknown>> = [];
  for await (const msg of await agent.prompt("hello from NATS client")) {
    messages.push({ ...msg });
  }
  if (!messages.some((m) => m.type === "response" && String(m.text ?? "").includes("plugin echo"))) {
    throw new Error(`prompt stream missing plugin echo response: ${JSON.stringify(messages)}`);
  }

  await stopProcess(opencode, "SIGINT");
  const disposeObservedAfterStop = await waitForOptional(() => logContains(pluginLog, "dispose complete"), 5_000);

  const opencode2Log = join(artifactDir, "opencode-restart.log");
  const opencode2 = Bun.spawn(["zsh", "-lic", `npx --yes opencode-ai@1.17.1 serve --hostname 127.0.0.1 --port ${ocPort} --print-logs --log-level DEBUG`], {
    cwd: projectDir,
    env: {
      ...process.env,
      SYNADIA_NATS_URL: natsUrl,
      SYNADIA_PLUGIN_LOG: pluginLog,
      SYNADIA_OWNER: owner,
      SYNADIA_SESSION: session,
    },
    stdout: Bun.file(opencode2Log),
    stderr: Bun.file(opencode2Log),
  });
  await waitFor(async () => isTcpOpen(ocPort), 10_000, "opencode restart ready");
  const restartCreated = await fetch(`http://127.0.0.1:${ocPort}/session?directory=${encodeURIComponent(projectDir)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
  const restartCreatedText = await restartCreated.text();
  if (!restartCreated.ok) throw new Error(`restart POST /session failed ${restartCreated.status}: ${restartCreatedText}`);
  await waitFor(() => countLog(pluginLog, "nats service registered") >= 2, 60_000, "plugin restart registration");
  const foundAfterRestart = await agents.discover({ timeoutMs: 2_000, filter: { agent: "opencode", owner, name: session } });
  if (foundAfterRestart.length !== 1) throw new Error(`expected one registered plugin agent after restart, found ${foundAfterRestart.length}`);
  await stopProcess(opencode2, "SIGINT");
  const disposeObservedAfterRestart = await waitForOptional(() => countLog(pluginLog, "dispose complete") >= 2, 5_000);

  const result = {
    ok: true,
    versions: {
      opencode: "1.17.1 via npx opencode-ai@1.17.1",
    },
    artifactDir,
    projectDir,
    natsUrl,
    opencodeUrl: `http://127.0.0.1:${ocPort}`,
    subject: agent.promptEndpoint.subject,
    promptEndpoint: agent.promptEndpoint,
    metadata: agent.metadata,
    promptMessages: messages,
    sessionCreateStatus: created.status,
    sessionCreateBodyKeys: safeJsonKeys(createdText),
    messageCreateBodyKeys: safeJsonKeys(messageText),
    pluginEventTypes: summarizePluginEvents(pluginLog),
    cleanup: {
      disposeCompleteCount: countLog(pluginLog, "dispose complete"),
      registrationCount: countLog(pluginLog, "nats service registered"),
      duplicateRegistrationAfterRestart: foundAfterRestart.length !== 1,
      disposeObservedAfterStop,
      disposeObservedAfterRestart,
    },
    logs: { pluginLog, opencodeLog, natsLog, opencodeRestartLog: opencode2Log },
  };
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  } finally {
    await nc?.close();
    if (!opencode.killed) await stopProcess(opencode, "SIGTERM").catch(() => undefined);
    if (!nats.killed) await stopProcess(nats, "SIGTERM").catch(() => undefined);
    if (process.env.KEEP_SPIKE_PROJECT !== "1") rmSync(projectDir, { recursive: true, force: true });
  }
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

function safeJsonKeys(text: string): string[] {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? Object.keys(value).sort() : [];
  } catch {
    return [];
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

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

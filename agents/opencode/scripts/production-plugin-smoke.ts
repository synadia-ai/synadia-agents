#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createConnection, createServer } from "node:net";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type Agent, type StreamMessage } from "@synadia-ai/agents";
import { activeSynadiaPluginChannelCount, stopAllSynadiaPluginChannels } from "@synadia-ai/opencode-nats-channel/opencode-plugin";
import type { OpenCodePluginContext } from "../src/plugin/types.js";

const packageRoot = new URL("..", import.meta.url).pathname;

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

async function main(): Promise<void> {
  const artifactDir = process.env.OPENCODE_PROD_PLUGIN_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "opencode-production-plugin-smoke-"));
  mkdirSync(artifactDir, { recursive: true });
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-production-plugin-project-"));
  const wrapperDir = mkdtempSync(join(packageRoot, ".tmp-production-plugin-wrapper-"));
  const wrapperPath = join(wrapperDir, "synadia-channel.ts");
  writeFileSync(wrapperPath, "import { SynadiaChannelPlugin } from '@synadia-ai/opencode-nats-channel/opencode-plugin';\n\nexport default SynadiaChannelPlugin;\n");

  const nats = await ensureNats();
  const restoreEnv = snapshotEnv([
    "SYNADIA_NATS_URL",
    "NATS_URL",
    "SYNADIA_OPENCODE_OWNER",
    "SYNADIA_OWNER",
    "SYNADIA_OPENCODE_SESSION",
    "SYNADIA_SESSION",
    "OPENCODE_SESSION_ID",
    "OPENCODE_PERMISSION_POLICY",
    "OPENCODE_PERMISSION_TIMEOUT_MS",
  ]);

  const owner = `prod-owner-${Math.random().toString(36).slice(2, 8)}`;
  const sessionName = `prod-plugin-${Math.random().toString(36).slice(2, 8)}`;
  const createdSessionId = `ses_prod_${Math.random().toString(36).slice(2, 10)}`;
  const createCalls: unknown[] = [];
  const promptCalls: unknown[] = [];
  const permissionReplies: unknown[] = [];
  let releasePrompt: (() => void) | undefined;
  let promptStarted: (() => void) | undefined;
  const promptStartedPromise = new Promise<void>((resolve) => { promptStarted = resolve; });
  const releasePromptPromise = new Promise<void>((resolve) => { releasePrompt = resolve; });

  const ctx: OpenCodePluginContext = {
    directory: projectDir,
    client: {
      session: {
        create: async (input) => {
          createCalls.push(input);
          return { data: { id: createdSessionId } };
        },
        prompt: async (input) => {
          promptCalls.push(input);
          promptStarted?.();
          await releasePromptPromise;
          return { data: { parts: [{ type: "text", text: "production plugin prompt complete" }] } };
        },
      },
      permission: {
        reply: async (input) => {
          permissionReplies.push(input);
          return {};
        },
      },
    },
  };

  let nc: Awaited<ReturnType<typeof natsConnect>> | undefined;
  try {
    process.env.SYNADIA_NATS_URL = nats.url;
    process.env.NATS_URL = nats.url;
    process.env.SYNADIA_OPENCODE_OWNER = owner;
    process.env.SYNADIA_OPENCODE_SESSION = sessionName;
    process.env.OPENCODE_PERMISSION_POLICY = "query";
    process.env.OPENCODE_PERMISSION_TIMEOUT_MS = "5000";
    delete process.env.OPENCODE_SESSION_ID;

    const wrapperModule = await import(pathToFileURL(wrapperPath).href) as { default: (ctx: OpenCodePluginContext) => Promise<{ event(input: { event: unknown }): Promise<void>; dispose(): Promise<void> }> };
    const hooks = await wrapperModule.default(ctx);
    const duplicateHooks = await wrapperModule.default(ctx);
    if (activeSynadiaPluginChannelCount() !== 1) throw new Error(`expected one production plugin channel after duplicate init, got ${activeSynadiaPluginChannelCount()}`);

    nc = await natsConnect({ servers: nats.url });
    const agents = new Agents({ nc });
    const agent = await discoverOne(agents, owner, sessionName);
    if (!agent.promptEndpoint.subject.includes(`.${owner}.${sessionName}`)) throw new Error(`unexpected production plugin subject ${agent.promptEndpoint.subject}`);
    if (agent.metadata["opencode_mode"] !== "plugin") throw new Error(`expected opencode_mode=plugin metadata, got ${JSON.stringify(agent.metadata)}`);

    const promptRun = collectPrompt(agent, "exercise production plugin export without OPENCODE_SESSION_ID");
    await withTimeout(promptStartedPromise, 5_000, "production plugin prompt to reach fake OpenCode session.prompt");
    await hooks.event({ event: { type: "permission.asked", properties: { id: "per_prod_1", sessionID: createdSessionId, permission: "bash", pattern: "production-plugin-smoke" } } });
    releasePrompt?.();
    const messages = await promptRun;

    const promptSessionIds = promptCalls.map((call) => isRecord(call) && isRecord(call.path) ? call.path.id : undefined);
    if (createCalls.length !== 1) throw new Error(`expected one session.create call for missing OPENCODE_SESSION_ID, got ${createCalls.length}`);
    if (promptCalls.length !== 1) throw new Error(`expected one session.prompt call, got ${promptCalls.length}`);
    if (promptSessionIds.some((id) => id === "default")) throw new Error(`production plugin called OpenCode with invalid default session id: ${JSON.stringify(promptSessionIds)}`);
    if (promptSessionIds[0] !== createdSessionId) throw new Error(`production plugin prompt did not use created session id: ${JSON.stringify(promptSessionIds)}`);
    if (!messages.some((msg) => msg.type === "query" && msg.prompt.includes("OpenCode requests permission"))) throw new Error(`production plugin smoke missing permission query: ${JSON.stringify(summarizeMessages(messages))}`);
    if (!permissionReplies.some((reply) => isRecord(reply) && reply.requestID === "per_prod_1" && reply.reply === "always")) throw new Error(`production plugin did not reply to permission through plugin API: ${JSON.stringify(permissionReplies)}`);
    if (!messages.some((msg) => msg.type === "response" && msg.text.includes("production plugin prompt complete"))) throw new Error(`production plugin smoke missing prompt response: ${JSON.stringify(summarizeMessages(messages))}`);
    const last = messages.at(-1);
    if (!last || last.type !== "status" || last.status !== "done") throw new Error(`production plugin smoke missing done status: ${JSON.stringify(summarizeMessages(messages))}`);

    await duplicateHooks.dispose();
    await hooks.dispose();
    if (activeSynadiaPluginChannelCount() !== 0) throw new Error(`expected zero production plugin channels after dispose, got ${activeSynadiaPluginChannelCount()}`);

    console.log(JSON.stringify({
      ok: true,
      exercised: "@synadia-ai/opencode-nats-channel/opencode-plugin via generated wrapper import",
      artifactDir,
      wrapperPath,
      natsUrl: nats.url,
      owner,
      session: sessionName,
      subject: agent.promptEndpoint.subject,
      metadata: agent.metadata,
      noConfiguredOpenCodeSessionId: true,
      createdSessionId,
      sessionCreateCalls: createCalls.length,
      promptSessionIds,
      duplicateInitPreservedSingleton: true,
      permissionReplies,
      messageSummary: summarizeMessages(messages),
    }, null, 2));
  } finally {
    await nc?.close();
    await stopAllSynadiaPluginChannels().catch(() => undefined);
    restoreEnv();
    await nats.close();
    if (process.env.KEEP_PROD_PLUGIN_SMOKE !== "1") {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(wrapperDir, { recursive: true, force: true });
      if (!process.env.OPENCODE_PROD_PLUGIN_ARTIFACT_DIR) rmSync(artifactDir, { recursive: true, force: true });
    }
  }
}

async function collectPrompt(agent: Agent, prompt: string): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const msg of await agent.prompt(prompt)) {
    messages.push(msg);
    if (msg.type === "query") await msg.reply("always");
  }
  return messages;
}

async function discoverOne(agents: Agents, owner: string, name: string): Promise<Agent> {
  const found = await agents.discover({ timeoutMs: 2_000, filter: { agent: "opencode", owner, name } });
  if (found.length !== 1) throw new Error(`expected one production plugin agent, found ${found.length}`);
  return found[0]!;
}

function summarizeMessages(messages: readonly StreamMessage[]): Array<Record<string, unknown>> {
  return messages.map((msg) => {
    if (msg.type === "status") return { type: msg.type, status: msg.status };
    if (msg.type === "response") return { type: msg.type, text: msg.text };
    if (msg.type === "query") return { type: msg.type, prompt: msg.prompt };
    return { type: String((msg as { type?: unknown }).type) };
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
    await waitForPort(port, 5_000);
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
    if (await canConnect(port)) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for 127.0.0.1:${port}`);
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)),
  ]);
}

function snapshotEnv(keys: readonly string[]): () => void {
  const before = new Map(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

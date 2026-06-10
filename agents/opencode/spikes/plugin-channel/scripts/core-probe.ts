#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";
import { createSynadiaChannel, type PermissionReply } from "../src/synadia-channel-core.ts";

const artifactDir = process.env.SPIKE_ARTIFACT_DIR ?? join(tmpdir(), `opencode-plugin-core-probe-${timestamp()}`);
mkdirSync(artifactDir, { recursive: true });
const natsPort = await freePort();
const natsUrl = `nats://127.0.0.1:${natsPort}`;
const natsLog = join(artifactDir, "nats-server.log");
const pluginLog = join(artifactDir, "core-plugin.ndjson");
const resultPath = join(artifactDir, "result.json");

const nats = Bun.spawn(["nats-server", "-p", String(natsPort)], { stdout: Bun.file(natsLog), stderr: Bun.file(natsLog) });
await waitFor(async () => isTcpOpen(natsPort), 10_000, "nats-server ready");

let replyCall: { requestID: string; reply: PermissionReply; message?: string } | undefined;
const channel = await createSynadiaChannel({
  client: {
    permission: {
      reply: async (input) => { replyCall = input; },
    },
  },
  project: { id: "generic-project-id" },
  directory: "/tmp/generic-opencode-project",
  worktree: "/tmp/generic-opencode-project",
  serverUrl: new URL("http://127.0.0.1:4096"),
}, { natsUrl, owner: "probe-owner", session: "probe-session", logPath: pluginLog, heartbeatIntervalS: 1, keepaliveIntervalS: null });

let nc: Awaited<ReturnType<typeof natsConnect>> | undefined;
try {
  nc = await natsConnect({ servers: natsUrl });
  const agents = new Agents({ nc });
  const found = await agents.discover({ timeoutMs: 1_000, filter: { agent: "opencode", owner: "probe-owner", name: "probe-session" } });
  if (found.length !== 1) throw new Error(`expected one probe agent before dispose, found ${found.length}`);

  channel.state.activePrompts.set("ses_probe", {
    sessionID: "ses_probe",
    response: {
      send: async () => undefined,
      ask: async () => ({ prompt: "always" }),
    },
  });
  await channel.hooks.event({ event: { type: "permission.asked", properties: { id: "perm_probe", sessionID: "ses_probe", permission: "bash", patterns: ["echo *"] } } });
  if (!replyCall || replyCall.requestID !== "perm_probe" || replyCall.reply !== "always") {
    throw new Error(`permission reply bridge failed: ${JSON.stringify(replyCall)}`);
  }

  await channel.hooks.dispose();
  const foundAfterDispose = await discoverOrEmpty(agents, { timeoutMs: 500, filter: { agent: "opencode", owner: "probe-owner", name: "probe-session" } });
  const result = {
    ok: true,
    artifactDir,
    subject: channel.state.subject,
    beforeDisposeCount: found.length,
    afterDisposeCount: foundAfterDispose.length,
    disposeCount: channel.state.disposeCount,
    permissionReply: replyCall,
    eventTypes: Object.fromEntries(channel.state.eventTypes),
    logs: { pluginLog, natsLog },
  };
  if (result.afterDisposeCount !== 0) throw new Error(`expected zero agents after dispose, found ${result.afterDisposeCount}`);
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await nc?.close();
  if (!nats.killed) {
    nats.kill("SIGTERM");
    await Promise.race([nats.exited.catch(() => undefined), delay(2_000)]);
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
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function discoverOrEmpty(agents: Agents, input: Parameters<Agents["discover"]>[0]) {
  try {
    return await agents.discover(input);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no responders")) return [];
    throw err;
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

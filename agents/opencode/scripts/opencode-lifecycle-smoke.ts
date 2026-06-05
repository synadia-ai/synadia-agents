#!/usr/bin/env bun
import { createConnection, createServer } from "node:net";
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk";
import type { OpenCodeChannelConfig } from "../src/config.js";
import { runDoctorChecks } from "../src/doctor.js";
import { createOpenCodeClient } from "../src/opencode-client.js";

const managedPort = await freePort();
const managed = await createOpencodeServer({ hostname: "127.0.0.1", port: managedPort });
const lifecycle: Record<string, unknown> = { managedUrl: managed.url };

try {
  await waitForHttp(new URL("/", managed.url), 5000);
  const sdk = createOpencodeClient({ baseUrl: managed.url, directory: process.cwd() });
  const sessionsBefore = await sdk.session.list();
  const created = await sdk.session.create({ body: { title: "opencode-nats-lifecycle-smoke" } });
  const sessionId = readString(created.data, "id");
  if (!sessionId) throw new Error(`session.create did not return an id: ${JSON.stringify(created)}`);
  const events = await sdk.event.subscribe({ sseMaxRetryAttempts: 0 });
  const firstEvent = await withTimeout(first(events.stream), 5000, "timed out waiting for OpenCode SSE server.connected event");
  if (readString(firstEvent, "type") !== "server.connected") throw new Error(`expected server.connected event, got ${JSON.stringify(firstEvent)}`);
  lifecycle["sessionsBefore"] = Array.isArray(sessionsBefore.data) ? sessionsBefore.data.length : null;
  lifecycle["createdSession"] = sessionId;
  lifecycle["firstEvent"] = readString(firstEvent, "type");
} finally {
  managed.close();
}

let closedProbeFailed = false;
try {
  await waitForHttp(new URL("/", managed.url), 750);
} catch {
  closedProbeFailed = true;
}
if (!closedProbeFailed) throw new Error("managed OpenCode server still answered after close()");
lifecycle["managedCloseVerified"] = true;

const attachedPort = await freePort();
const attached = await createOpencodeServer({ hostname: "127.0.0.1", port: attachedPort });
try {
  const config: OpenCodeChannelConfig = {
    nats: { url: "nats://127.0.0.1:4222" },
    agent: { owner: "smoke", name: "attached", subjectToken: "opencode", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
    opencode: {
      mode: "attached",
      baseUrl: attached.url,
      hostname: "127.0.0.1",
      port: attachedPort,
      directory: process.cwd(),
      permissionPolicy: "query",
      permissionTimeoutMs: 5000,
    },
  };
  const checks = await runDoctorChecks(config, { commandExists: async () => false });
  const httpCheck = checks.find((check) => check.name === "opencode-http");
  if (!httpCheck?.ok) throw new Error(`attached doctor probe failed: ${JSON.stringify(httpCheck)}`);

  let startedSecondServer = false;
  const bridge = await createOpenCodeClient(config, {
    createManagedServer: async () => {
      startedSecondServer = true;
      throw new Error("attached mode must not start a managed server");
    },
  });
  if (bridge.mode !== "attached") throw new Error(`expected attached bridge mode, got ${bridge.mode}`);
  if (startedSecondServer) throw new Error("attached adapter started a second OpenCode server");
  await bridge.close?.();
  lifecycle["attachedUrl"] = attached.url;
  lifecycle["attachedDoctor"] = httpCheck.message;
  lifecycle["attachedNoSecondServer"] = true;
} finally {
  attached.close();
}

console.log(JSON.stringify(lifecycle, null, 2));

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

async function waitForHttp(url: URL, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status > 0) return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error(`${url.toString()} did not answer within ${timeoutMs}ms`);
}

async function first(stream: AsyncIterable<unknown>): Promise<unknown> {
  for await (const event of stream) return event;
  throw new Error("event stream ended before first event");
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

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

#!/usr/bin/env bun
import { createServer } from "node:net";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { OpenCodeBridgeEvent } from "../src/bridge.js";
import type { OpenCodeChannelConfig } from "../src/config.js";
import { createOpenCodeClient } from "../src/opencode-client.js";

const DEFAULT_ENV_FILE = join(resolveUserHome(), ".hermes", "projects", "synadia-agents-opencode", "secrets", "opencode-openrouter.env");
const envFile = process.env["OPENCODE_TEST_ENV_FILE"] ?? DEFAULT_ENV_FILE;
const loaded = loadScopedEnv(envFile);
const model = process.env["OPENCODE_TEST_MODEL"];
if (!process.env["OPENROUTER_API_KEY"]) throw new Error(`${envFile} did not provide OPENROUTER_API_KEY`);
if (!model) throw new Error(`${envFile} did not provide OPENCODE_TEST_MODEL`);

const port = await freePort();
const expected = `OPENCODE_NATS_RUNTIME_SMOKE_OK_${Math.random().toString(36).slice(2, 8)}`;
const config: OpenCodeChannelConfig = {
  nats: { url: "nats://127.0.0.1:4222" },
  agent: { owner: "smoke", name: "runtime", subjectToken: "opencode", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
  opencode: {
    mode: "managed",
    hostname: "127.0.0.1",
    port,
    directory: process.cwd(),
    model,
    permissionPolicy: "reject",
    permissionTimeoutMs: 5000,
  },
};

const client = await createOpenCodeClient(config);
const events: OpenCodeBridgeEvent[] = [];
try {
  const prompt = `Respond with exactly this token and no other text: ${expected}`;
  await withTimeout(collect(client.prompt({ prompt }), events), 120000, "OpenCode runtime prompt did not finish within 120s");
} finally {
  await client.close?.();
}

const text = events.filter((event) => event.type === "response").map((event) => event.text).join("");
if (!text.includes(expected)) {
  throw new Error(`runtime smoke response did not include expected token ${expected}; got ${JSON.stringify(text.slice(0, 500))}`);
}

console.log(JSON.stringify({
  envFile,
  loadedKeys: loaded,
  model,
  mode: client.mode,
  responseChunks: events.filter((event) => event.type === "response").length,
  statusChunks: events.filter((event) => event.type === "status").length,
  expectedSeen: true,
}, null, 2));
await Bun.sleep(50);
process.exit(0);

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
    let value = match[2] ?? "";
    value = value.replace(/^['\"]|['\"]$/g, "");
    process.env[key] = value;
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

async function collect(stream: AsyncIterable<OpenCodeBridgeEvent>, out: OpenCodeBridgeEvent[]): Promise<void> {
  for await (const event of stream) out.push(event);
}

#!/usr/bin/env bun
import { ManagedCodexRuntime } from "../src/managed-runtime.js";
import type { CodexChannelConfig } from "../src/config.js";

const config: CodexChannelConfig = {
  // Required by CodexChannelConfig; this smoke exercises only the stdio app-server runtime and never connects to NATS.
  nats: { url: "nats://127.0.0.1:4222" },
  agent: { owner: "smoke", session: "permission", subjectToken: "codex", heartbeatIntervalS: 1, keepaliveIntervalS: 1 },
  codex: { mode: "managed", codexBin: "bun", permissionPolicy: "reject" },
  manager: { enabled: false, autoExposeCurrentSessions: false, autoExposeFutureSessions: false, watchMode: "event-plus-poll", watchIntervalMs: 7500, staleGraceIntervals: 3, exposeEphemeralLoadedSessions: false },
};

const runtime = new ManagedCodexRuntime({ config, command: "bun", args: ["scripts/fake-codex-app-server.ts"], cwd: process.cwd(), permissionTimeoutMs: 250 });
try {
  await runtime.start();
  const chunks: string[] = [];
  for await (const event of runtime.prompt({ prompt: "trigger permission", publicSession: "permission", permissionPolicy: "reject" })) {
    if (event.type === "response") chunks.push(event.text);
  }
  const text = chunks.join("");
  if (!text.includes("permission:cancel") && !text.includes("permission:decline")) throw new Error(`permission was not denied/cancelled by default: ${text}`);
  console.log(JSON.stringify({ ok: true, defaultDecision: text, sideEffect: "not-run-by-fake-server" }, null, 2));
} finally {
  await runtime.close();
}

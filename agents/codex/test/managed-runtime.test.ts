import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedCodexRuntime } from "../src/managed-runtime.js";
import type { CodexChannelConfig } from "../src/config.js";

function config(): CodexChannelConfig {
  return {
    nats: { url: "nats://127.0.0.1:4222" },
    agent: { owner: "test", session: "managed", subjectToken: "codex", heartbeatIntervalS: 1, keepaliveIntervalS: 1 },
    codex: { mode: "managed", codexBin: "bun", permissionPolicy: "reject" },
    manager: { enabled: false, autoExposeCurrentSessions: false, autoExposeFutureSessions: false, watchMode: "event-plus-poll", watchIntervalMs: 7500, staleGraceIntervals: 3, exposeEphemeralLoadedSessions: false },
  };
}

describe("ManagedCodexRuntime", () => {
  test("defers auto CODEX_HOME creation until start and removes it on close", async () => {
    const runtime = new ManagedCodexRuntime({ config: config(), command: "bun", args: ["scripts/fake-codex-app-server.ts"], cwd: process.cwd() });
    expect(runtime.codeHome).toBeUndefined();
    try {
      await runtime.start();
      const codeHome = runtime.codeHome;
      expect(codeHome).toBeDefined();
      expect(existsSync(codeHome!)).toBe(true);
    } finally {
      const codeHome = runtime.codeHome;
      await runtime.close();
      if (codeHome) expect(existsSync(codeHome)).toBe(false);
    }
  });

  test("creates user-supplied CODEX_HOME on start and does not delete it on close", async () => {
    const root = mkdtempSync(join(tmpdir(), "managed-codex-user-home-test-"));
    const codeHome = join(root, "existing-auth-home");
    const base = config();
    const cfg: CodexChannelConfig = { ...base, codex: { ...base.codex, codeHome } };
    const runtime = new ManagedCodexRuntime({ config: cfg, command: "bun", args: ["scripts/fake-codex-app-server.ts"], cwd: process.cwd() });
    expect(runtime.codeHome).toBe(codeHome);
    expect(existsSync(codeHome)).toBe(false);
    try {
      await runtime.start();
      expect(existsSync(codeHome)).toBe(true);
    } finally {
      await runtime.close();
      expect(existsSync(codeHome)).toBe(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("streams Codex app-server deltas without adding an empty response", async () => {
    const runtime = new ManagedCodexRuntime({ config: config(), command: "bun", args: ["scripts/fake-codex-app-server.ts"], cwd: process.cwd() });
    try {
      await runtime.start();
      const events = [];
      for await (const event of runtime.prompt({ prompt: "hello", publicSession: "managed", permissionPolicy: "reject" })) events.push(event);
      expect(events.some((event) => event.type === "response" && event.text === "")).toBe(false);
      expect(events.filter((event) => event.type === "response").map((event) => event.text).join("")).toContain("fake Codex response to hello");
      expect(events.at(-1)).toEqual({ type: "done" });
    } finally {
      await runtime.close();
    }
  });

  test("defaults permission requests to cancel/deny", async () => {
    const runtime = new ManagedCodexRuntime({ config: config(), command: "bun", args: ["scripts/fake-codex-app-server.ts"], cwd: process.cwd(), permissionTimeoutMs: 100 });
    try {
      await runtime.start();
      const chunks = [];
      for await (const event of runtime.prompt({ prompt: "permission", publicSession: "managed", permissionPolicy: "reject" })) {
        if (event.type === "response") chunks.push(event.text);
      }
      expect(chunks.join("")).toContain("permission:cancel");
    } finally {
      await runtime.close();
    }
  });

  test("adapter-owned permission callback can approve when policy is query", async () => {
    const queryConfig = config();
    const runtime = new ManagedCodexRuntime({ config: queryConfig, command: "bun", args: ["scripts/fake-codex-app-server.ts"], cwd: process.cwd(), permissionTimeoutMs: 100 });
    try {
      await runtime.start();
      const chunks = [];
      for await (const event of runtime.prompt({
        prompt: "permission",
        publicSession: "managed",
        permissionPolicy: "query",
        askPermission: async () => "approve",
      })) {
        if (event.type === "response") chunks.push(event.text);
      }
      expect(chunks.join("")).toContain("permission:accept");
    } finally {
      await runtime.close();
    }
  });
});

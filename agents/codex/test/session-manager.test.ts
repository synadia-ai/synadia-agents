import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EndpointRegistry } from "../src/endpoint-registry.js";
import { allocateAliases, CodexSessionManager } from "../src/session-manager.js";
import { BoundedPollScheduler, isThreadStartedNotification } from "../src/session-watch.js";
import { normalizePluginNotification, readPluginState } from "../src/plugin-registrar.js";
import type { EligibleSessionRow } from "../src/session-inventory.js";
import { privateSessionKey } from "../src/identity.js";

function row(endpoint: string, rawThreadId: string): EligibleSessionRow {
  return {
    endpoint,
    endpointFingerprint: "fingerprint",
    rawThreadId,
    privateKey: privateSessionKey(endpoint, rawThreadId),
    loaded: true,
    listed: true,
    ephemeral: false,
    turnCount: 1,
    thread: { id: rawThreadId, turns: [{}] },
    eligible: true,
    readOk: true,
    resumeOk: true,
    reason: "eligible",
  };
}

describe("Codex session manager alias policy", () => {
  test("requires explicit endpoint registry and derives safe aliases without raw ids", () => {
    expect(() => new EndpointRegistry([])).toThrow("explicit endpoints");
    const endpoint = "unix:///Users/alice/private/codex.sock";
    const rows = [row(endpoint, "raw-private-thread-a"), row(endpoint, "raw-private-thread-b")];
    const aliases = allocateAliases(rows, new EndpointRegistry([{ id: "known", endpoint }]).list());
    expect(new Set(aliases.values()).size).toBe(2);
    for (const alias of aliases.values()) {
      expect(alias).toMatch(/^session-[a-f0-9]{12}$/);
      expect(alias).not.toContain("raw-private-thread");
      expect(alias).not.toContain("Users");
    }
  });

  test("fails explicit alias collisions loudly", () => {
    const endpoint = "unix:///tmp/known-codex.sock";
    const rows = [row(endpoint, "raw-a"), row(endpoint, "raw-b")];
    const registry = new EndpointRegistry([{ id: "known", endpoint, explicitAliases: { "raw-a": "same", "raw-b": "same" } }]);
    expect(() => allocateAliases(rows, registry.list())).toThrow("explicit manager alias collision");
  });

  test("treats thread/started as a wakeup signal only", () => {
    expect(isThreadStartedNotification({ method: "thread/started", params: { threadId: "raw-private-thread" } })).toBe(true);
    expect(isThreadStartedNotification({ method: "turn/completed", params: { threadId: "raw-private-thread" } })).toBe(false);
  });

  test("records plugin-origin events and reconciles configured endpoints without marking them promptable first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-manager-plugin-"));
    const statePath = join(dir, "last-event.json");
    const endpoint = "unix:///tmp/plugin-known-codex.sock";
    let reconcileAttempts = 0;
    const manager = new CodexSessionManager({
      nc: { flush: async () => undefined } as never,
      version: "0.1.0-test",
      registry: new EndpointRegistry([{ id: "plugin-known", endpoint }]),
      clientFactory: async () => {
        reconcileAttempts += 1;
        throw new Error("endpoint intentionally unavailable in unit test");
      },
      config: {
        nats: { url: "nats://127.0.0.1:4222" },
        agent: { owner: "local", session: "manager", subjectToken: "codex", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
        codex: { mode: "manager", codexBin: "codex", permissionPolicy: "external-owner" },
        manager: { enabled: true, autoExposeCurrentSessions: false, autoExposeFutureSessions: true, endpoints: [endpoint], watchMode: "poll", watchIntervalMs: 7500, staleGraceIntervals: 3, exposeEphemeralLoadedSessions: false },
        plugin: { enabled: true, registrarHost: "127.0.0.1", registrarPort: 8717, registrarToken: "not-secret-shaped", statePath },
      },
    });
    try {
      const event = normalizePluginNotification({ event: "SessionStart", endpoint, threadId: "thread-fixture-plugin" });
      const snapshots = await manager.notifyPluginEvent(event);
      expect(reconcileAttempts).toBe(1);
      expect(manager.endpointErrorCount).toBe(1);
      expect(manager.pluginLastEvent?.event).toBe("SessionStart");
      expect(snapshots).toHaveLength(0);
      expect(readPluginState(statePath).lastEvent?.registrationState).toBe("metadata-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("coalesces overlapping poll wakeups", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const scheduler = new BoundedPollScheduler(10_000, async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const first = scheduler.trigger();
    const second = scheduler.trigger();
    const third = scheduler.trigger();
    expect(calls).toBe(1);
    release?.();
    await waitUntil(() => calls === 2);
    release?.();
    await Promise.all([first, second, third]);
    expect(calls).toBe(2);
    scheduler.stop();
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met before timeout");
}

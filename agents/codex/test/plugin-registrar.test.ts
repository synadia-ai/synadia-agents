import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexPluginRegistrar,
  emitCodexPluginNotification,
  normalizePluginNotification,
  pluginEventSnapshot,
  readPluginState,
  writePluginState,
} from "../src/plugin-registrar.js";

const privateEndpoint = "unix:///Users/alice/private/codex.sock";
const privateThreadId = "thread-private-alpha";

describe("Codex plugin-assisted registration", () => {
  test("hook notifications reach the local registrar and stay metadata-only by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-plugin-"));
    const statePath = join(dir, "last-event.json");
    const events: ReturnType<typeof normalizePluginNotification>[] = [];
    const registrar = new CodexPluginRegistrar({
      host: "127.0.0.1",
      port: 0,
      token: "test-registrar-token",
      statePath,
      onEvent: (event) => { events.push(event); },
    });
    registrar.start();
    try {
      const result = await emitCodexPluginNotification({
        registrarUrl: registrar.url!,
        token: "test-registrar-token",
        event: { event: "SessionStart", endpoint: privateEndpoint, threadId: privateThreadId, source: "codex-plugin-hook" },
      });
      expect(result.status).toBe(202);
      expect(events).toHaveLength(1);
      expect(events[0]?.registrationState).toBe("metadata-only");
      expect(events[0]?.privateKey).toContain(privateThreadId);
      const state = readPluginState(statePath);
      expect(state.lastEvent?.event).toBe("SessionStart");
      expect(state.lastEvent?.registrationState).toBe("metadata-only");
      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain(privateEndpoint);
      expect(serialized).not.toContain(privateThreadId);
      expect(serialized).not.toContain("/Users/alice");
    } finally {
      await registrar.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("registrar rejects untrusted hook notifications", async () => {
    const registrar = new CodexPluginRegistrar({ host: "127.0.0.1", port: 0, token: "trusted-token" });
    registrar.start();
    try {
      const result = await emitCodexPluginNotification({
        registrarUrl: registrar.url!,
        token: "wrong-token",
        event: { event: "SessionStart" },
      });
      expect(result.status).toBe(401);
    } finally {
      await registrar.stop();
    }
  });

  test("manager can promote the same plugin-origin event only after promptability proof", () => {
    const event = normalizePluginNotification({ event: "SessionStart", endpoint: privateEndpoint, threadId: privateThreadId });
    expect(pluginEventSnapshot(event).registrationState).toBe("metadata-only");
    expect(pluginEventSnapshot(event, true).registrationState).toBe("promptable");
  });

  test("plugin state persists only redacted doctor-safe event details", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-plugin-state-"));
    const statePath = join(dir, "last-event.json");
    try {
      const event = normalizePluginNotification({ event: "SessionStop", endpoint: privateEndpoint, threadId: privateThreadId });
      writePluginState(statePath, pluginEventSnapshot(event, true));
      const state = readPluginState(statePath);
      expect(state.lastEvent?.registrationState).toBe("promptable");
      const serialized = JSON.stringify(state);
      expect(serialized).toContain("endpointFingerprint");
      expect(serialized).not.toContain(privateEndpoint);
      expect(serialized).not.toContain(privateThreadId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

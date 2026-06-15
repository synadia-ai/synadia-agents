import { describe, expect, test } from "bun:test";
import type { CodexChannelConfig } from "../src/config.js";
import { buildAgentServiceOptions } from "../src/service.js";

function cfg(overrides: Partial<CodexChannelConfig["codex"]> = {}): CodexChannelConfig {
  return {
    nats: { url: "nats://127.0.0.1:4222" },
    agent: { owner: "alice", session: "project-main", subjectToken: "codex", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
    codex: {
      mode: "attached",
      endpoint: "ws://127.0.0.1:9876/redacted",
      threadId: "raw-thread-id",
      publicAlias: "project-main",
      codexBin: "codex",
      permissionPolicy: "external-owner",
      ...overrides,
    },
    manager: {
      enabled: false,
      autoExposeCurrentSessions: false,
      autoExposeFutureSessions: false,
      watchMode: "event-plus-poll",
      watchIntervalMs: 7500,
      staleGraceIntervals: 3,
      exposeEphemeralLoadedSessions: false,
    },
  };
}

describe("service construction", () => {
  test("builds AgentService options for codex using canonical metadata", () => {
    const opts = buildAgentServiceOptions({ nc: {} as never, config: cfg(), version: "0.1.0" });
    expect(opts.agent).toBe("codex");
    expect(opts.subjectToken).toBe("codex");
    expect(opts.owner).toBe("alice");
    expect(opts.name).toBe("project-main");
    expect(opts.session).toBe("project-main");
    expect(opts.attachmentsOk).toBe(false);
    expect(opts.extraMetadata).toEqual({
      codex_mode: "attached",
      permission_policy: "external-owner",
      manager_enabled: "false",
    });
    expect(JSON.stringify(opts.extraMetadata)).not.toContain("raw-thread-id");
    expect(JSON.stringify(opts.extraMetadata)).not.toContain("9876");
  });
});

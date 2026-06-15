import { describe, expect, test } from "bun:test";
import { runDoctor } from "../src/doctor.js";
import type { CodexChannelConfig } from "../src/config.js";

describe("Codex doctor", () => {
  test("reports redacted managed app-server checks", async () => {
    const config: CodexChannelConfig = {
      nats: { url: "nats://127.0.0.1:4222", creds: "/Users/someone/private.creds" },
      agent: { owner: "local", session: "main", subjectToken: "codex", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
      codex: { mode: "managed", codexBin: "codex", codeHome: "/Users/someone/.codex", endpoint: "unix:///Users/someone/socket", threadId: "raw-thread-id", permissionPolicy: "query" },
      manager: { enabled: false, autoExposeCurrentSessions: false, autoExposeFutureSessions: false, watchMode: "event-plus-poll", watchIntervalMs: 7500, staleGraceIntervals: 3, exposeEphemeralLoadedSessions: false },
    };
    const report = await runDoctor(config);
    const serialized = JSON.stringify(report);
    expect(report.phase).toBe("managed-app-server");
    expect(serialized).toContain("agents.prompt.codex.local.main");
    expect(serialized).toContain("nats://127.0.0.1:4222");
    expect(serialized).not.toContain("raw-thread-id");
    expect(serialized).not.toContain("/Users/someone/.codex");
    expect(serialized).not.toContain("unix:///Users/someone/socket");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("plugin promptability gate");
  });
});

import { describe, expect, test } from "bun:test";
import type { AcpChannelConfig } from "../src/config.js";
import { buildAgentServiceOptions } from "../src/service.js";

function cfg(): AcpChannelConfig {
  return {
    nats: { url: "nats://127.0.0.1:4222" },
    agent: { owner: "alice", session: "project-main", subjectToken: "grok", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
    acp: {
      mode: "managed",
      preset: "grok",
      agentId: "grok",
      bin: "grok",
      args: ["agent", "stdio"],
      homeEnvVar: "GROK_HOME",
      cwd: "/tmp/project-main",
      permissionPolicy: "reject",
    },
  };
}

describe("service construction", () => {
  test("builds AgentService options from the preset identity", () => {
    const opts = buildAgentServiceOptions({ nc: {} as never, config: cfg(), version: "0.1.0" });
    expect(opts.agent).toBe("grok");
    expect(opts.subjectToken).toBe("grok");
    expect(opts.owner).toBe("alice");
    expect(opts.name).toBe("project-main");
    expect(opts.session).toBe("project-main");
    expect(opts.attachmentsOk).toBe(false);
    expect(opts.extraMetadata).toEqual({
      acp_preset: "grok",
      acp_mode: "managed",
      permission_policy: "reject",
    });
  });
});

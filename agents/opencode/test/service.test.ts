import { describe, expect, test } from "bun:test";
import { buildAgentServiceOptions } from "../src/service.js";
import type { OpenCodeChannelConfig } from "../src/config.js";

function cfg(overrides: Partial<OpenCodeChannelConfig["opencode"]> = {}): OpenCodeChannelConfig {
  return {
    nats: { url: "nats://127.0.0.1:4222" },
    agent: { owner: "alice", name: "project-main", subjectToken: "opencode", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
    opencode: {
      mode: "attached",
      baseUrl: "http://user:example@127.0.0.1:4096/path",
      hostname: "127.0.0.1",
      port: 4096,
      directory: "/tmp/project-main",
      permissionPolicy: "query",
      permissionTimeoutMs: 300000,
      ...overrides,
    },
  };
}

describe("service construction", () => {
  test("builds AgentService options for opencode using canonical metadata", () => {
    const opts = buildAgentServiceOptions({ nc: {} as never, config: cfg(), version: "0.1.0" });
    expect(opts.agent).toBe("opencode");
    expect(opts.subjectToken).toBe("opencode");
    expect(opts.owner).toBe("alice");
    expect(opts.name).toBe("project-main");
    expect(opts.session).toBe("project-main");
    expect(opts.attachmentsOk).toBe(false);
    expect(opts.extraMetadata).toEqual({
      opencode_mode: "attached",
      opencode_directory: "project-main",
      opencode_workspace: "",
      opencode_base_url_origin: "http://127.0.0.1:4096",
      permission_policy: "query",
    });
  });
});

import { describe, expect, test } from "bun:test";
import { buildAgentServiceOptions } from "../src/service.js";
import type { EveChannelConfig } from "../src/config.js";

function config(overrides: Partial<EveChannelConfig["eve"]> = {}): EveChannelConfig {
  return {
    nats: { url: "nats://127.0.0.1:4222" },
    agent: {
      owner: "rene",
      name: "support",
      subjectToken: "eve",
      heartbeatIntervalS: 30,
      keepaliveIntervalS: 30,
    },
    eve: {
      baseUrl: "http://127.0.0.1:2000",
      askTimeoutS: 120,
      ...overrides,
    },
  };
}

describe("service construction", () => {
  test("builds AgentService options for eve with attachments enabled", () => {
    const opts = buildAgentServiceOptions({ nc: {} as never, config: config(), version: "0.1.0" });
    expect(opts.agent).toBe("eve");
    expect(opts.subjectToken).toBe("eve");
    expect(opts.owner).toBe("rene");
    expect(opts.name).toBe("support");
    expect(opts.session).toBe("support");
    expect(opts.attachmentsOk).toBe(true);
    expect(opts.extraMetadata).toEqual({
      eve_base_url: "http://127.0.0.1:2000",
      eve_auth: "none",
    });
  });

  test("advertises bearer auth mode without ever exposing the token", () => {
    const opts = buildAgentServiceOptions({
      nc: {} as never,
      config: config({ authToken: "super-secret" }),
      version: "0.1.0",
    });
    expect(opts.extraMetadata).toEqual({
      eve_base_url: "http://127.0.0.1:2000",
      eve_auth: "bearer",
    });
    expect(JSON.stringify(opts.extraMetadata)).not.toContain("super-secret");
    expect(opts.description).not.toContain("super-secret");
  });
});

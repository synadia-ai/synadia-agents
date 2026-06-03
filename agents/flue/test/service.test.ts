import { describe, expect, test } from "bun:test";
import { buildAgentServiceOptions } from "../src/service.js";
import type { FlueChannelConfig } from "../src/config.js";

describe("service construction", () => {
  test("builds AgentService options for flue using canonical subject token and metadata", () => {
    const cfg: FlueChannelConfig = {
      nats: { url: "nats://127.0.0.1:4222" },
      agent: {
        owner: "rene",
        name: "support",
        subjectToken: "flue",
        heartbeatIntervalS: 30,
        keepaliveIntervalS: 30,
      },
      flue: {
        baseUrl: "http://127.0.0.1:3583",
        agent: "assistant",
        instance: "customer-123",
        session: "ticket-123",
        transport: "http-stream",
      },
    };
    const opts = buildAgentServiceOptions({
      nc: {} as never,
      config: cfg,
      version: "0.1.0",
    });
    expect(opts.agent).toBe("flue");
    expect(opts.subjectToken).toBe("flue");
    expect(opts.owner).toBe("rene");
    expect(opts.name).toBe("support");
    expect(opts.session).toBe("support");
    expect(opts.attachmentsOk).toBe(false);
    expect(opts.extraMetadata).toEqual({
      flue_base_url: "http://127.0.0.1:3583",
      flue_agent: "assistant",
      flue_instance: "customer-123",
      flue_session: "ticket-123",
      flue_transport: "http-stream",
    });
  });
});

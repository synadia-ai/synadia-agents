import { describe, expect, test } from "bun:test";
import { createOpenCodeClient } from "../src/opencode-client.js";
import type { OpenCodeChannelConfig } from "../src/config.js";

function cfg(mode: "managed" | "attached"): OpenCodeChannelConfig {
  return {
    nats: {},
    agent: { owner: "rene", name: "labrowser", subjectToken: "opencode", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
    opencode: {
      mode,
      ...(mode === "attached" ? { baseUrl: "http://127.0.0.1:4096" } : {}),
      hostname: "127.0.0.1",
      port: 4096,
      permissionPolicy: "query",
      permissionTimeoutMs: 300000,
    },
  };
}

describe("opencode client factory scaffold", () => {
  test("attached mode never starts a managed server", async () => {
    let started = false;
    let attached = false;
    const client = await createOpenCodeClient(cfg("attached"), {
      startManagedServer: async () => { started = true; },
      attachToServer: async () => { attached = true; },
    });
    expect(client.mode).toBe("attached");
    expect(started).toBe(false);
    expect(attached).toBe(true);
  });

  test("managed mode starts managed server seam", async () => {
    let started = false;
    const client = await createOpenCodeClient(cfg("managed"), {
      startManagedServer: async () => { started = true; },
    });
    expect(client.mode).toBe("managed");
    expect(started).toBe(true);
  });
});

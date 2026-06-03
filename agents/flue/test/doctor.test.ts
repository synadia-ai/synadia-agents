import { describe, expect, test } from "bun:test";
import { runDoctorChecks } from "../src/doctor.js";
import type { FlueChannelConfig } from "../src/config.js";

describe("doctor", () => {
  test("reports Flue HTTP reachability through injected fetch", async () => {
    const cfg: FlueChannelConfig = {
      nats: { url: "nats://127.0.0.1:4222" },
      agent: { owner: "rene", name: "support", subjectToken: "flue", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
      flue: { baseUrl: "http://flue.local", agent: "assistant", instance: "customer-123", session: "default", transport: "http-stream" },
    };
    const checks = await runDoctorChecks(cfg, { fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch });
    expect(checks.some((c) => c.name === "flue-http" && c.ok)).toBe(true);
  });

  test("treats HTTP 405 as reachable Flue server with unsupported probe method", async () => {
    const cfg: FlueChannelConfig = {
      nats: { url: "nats://127.0.0.1:4222" },
      agent: { owner: "rene", name: "support", subjectToken: "flue", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
      flue: { baseUrl: "http://flue.local", agent: "assistant", instance: "customer-123", session: "default", transport: "http-stream" },
    };
    const checks = await runDoctorChecks(cfg, { fetch: (async () => new Response("method", { status: 405 })) as unknown as typeof fetch });
    const flue = checks.find((c) => c.name === "flue-http");
    expect(flue?.ok).toBe(true);
    expect(flue?.message).toContain("reachable");
  });
});

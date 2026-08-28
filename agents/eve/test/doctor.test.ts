import { describe, expect, test } from "bun:test";
import { runDoctorChecks } from "../src/doctor.js";
import type { EveChannelConfig } from "../src/config.js";

function config(overrides: Partial<EveChannelConfig["eve"]> = {}): EveChannelConfig {
  return {
    nats: { url: "nats://127.0.0.1:4222" },
    agent: { owner: "rene", name: "support", subjectToken: "eve", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
    eve: { baseUrl: "http://eve.local:2000", askTimeoutS: 120, ...overrides },
  };
}

const INFO_BODY = JSON.stringify({ agent: { name: "support-bot", model: { id: "mock-model" } } });

describe("doctor", () => {
  test("reports healthy eve with agent name and model from /eve/v1/info", async () => {
    const fetchImpl = (async (url: URL | RequestInfo) =>
      url.toString().endsWith("/eve/v1/health")
        ? new Response(JSON.stringify({ ok: true, status: "ready" }), { status: 200 })
        : new Response(INFO_BODY, { status: 200 })) as unknown as typeof fetch;
    const checks = await runDoctorChecks(config(), { fetch: fetchImpl });
    expect(checks.find((c) => c.name === "eve-health")?.ok).toBe(true);
    const info = checks.find((c) => c.name === "eve-info");
    expect(info?.ok).toBe(true);
    expect(info?.message).toBe('agent "support-bot" (model mock-model)');
  });

  test("flags an unauthorized info route with an auth_token hint", async () => {
    const fetchImpl = (async (url: URL | RequestInfo) =>
      url.toString().endsWith("/eve/v1/health")
        ? new Response("ok", { status: 200 })
        : new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const checks = await runDoctorChecks(config(), { fetch: fetchImpl });
    const info = checks.find((c) => c.name === "eve-info");
    expect(info?.ok).toBe(false);
    expect(info?.message).toContain("reachable but unauthorized; set [eve] auth_token");
  });

  test("reports connection failures for both HTTP checks", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const checks = await runDoctorChecks(config(), { fetch: fetchImpl });
    expect(checks.find((c) => c.name === "eve-health")?.ok).toBe(false);
    expect(checks.find((c) => c.name === "eve-info")?.ok).toBe(false);
    expect(checks.find((c) => c.name === "eve-health")?.message).toContain("ECONNREFUSED");
  });

  test("sends the configured bearer token on probes", async () => {
    const seen: Array<string | undefined> = [];
    const fetchImpl = (async (_url: URL | RequestInfo, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.authorization);
      return new Response(INFO_BODY, { status: 200 });
    }) as unknown as typeof fetch;
    await runDoctorChecks(config({ authToken: "tok-1" }), { fetch: fetchImpl });
    expect(seen).toEqual(["Bearer tok-1", "Bearer tok-1"]);
  });
});

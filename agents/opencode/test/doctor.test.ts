import { describe, expect, test } from "bun:test";
import { formatDoctorChecks, redact, runDoctorChecks } from "../src/doctor.js";
import type { OpenCodeChannelConfig } from "../src/config.js";

function cfg(baseUrl?: string): OpenCodeChannelConfig {
  return {
    nats: { url: "nats://127.0.0.1:4222", creds: "/path/to/user.creds" },
    agent: { owner: "alice", name: "project-main", subjectToken: "opencode", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
    opencode: {
      mode: baseUrl ? "attached" : "managed",
      ...(baseUrl ? { baseUrl } : {}),
      hostname: "127.0.0.1",
      port: 4096,
      permissionPolicy: "query",
      permissionTimeoutMs: 300000,
    },
  };
}

describe("doctor", () => {
  test("treats HTTP 405 as reachable for attached liveness probes", async () => {
    const fetch405 = (async () => new Response(null, { status: 405 })) as unknown as typeof fetch;
    const checks = await runDoctorChecks(cfg("http://127.0.0.1:4096"), {
      dynamicImport: async () => ({}),
      fetch: fetch405,
    });
    expect(checks.find((c) => c.name === "opencode-http")).toEqual({
      name: "opencode-http",
      ok: true,
      message: "http://127.0.0.1:4096/event returned HTTP 405 (reachable; GET probe method unsupported)",
    });
  });

  test("managed mode checks the opencode binary", async () => {
    const commands: string[] = [];
    const checks = await runDoctorChecks(cfg(), {
      dynamicImport: async () => ({}),
      commandExists: async (cmd) => { commands.push(cmd); return cmd === "opencode"; },
    });
    expect(commands).toEqual(["opencode"]);
    expect(checks.find((c) => c.name === "opencode-binary")?.ok).toBe(true);
  });

  test("redacts secret-shaped diagnostics", () => {
    const nkeySeedShape = `S${"A".repeat(57)}`;
    const passwordDiagnostic = ["password", "example-value"].join("=");
    const credsDiagnostic = ["creds", "/path/to/user.creds"].join("=");
    expect(redact(`${passwordDiagnostic} ${credsDiagnostic} ${nkeySeedShape}`))
      .toBe("password=[REDACTED] creds=[REDACTED] [REDACTED]");
  });

  test("formats checks", () => {
    expect(formatDoctorChecks([{ name: "config", ok: true, message: "ok" }])).toBe("ok\tconfig\tok");
  });
});

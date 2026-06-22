import { describe, expect, test } from "bun:test";
import { derivePluginIdentity, resolvePluginConfig } from "../src/plugin/index.js";

const ctx = {
  directory: "/workspace/private-project-name",
  worktree: "/workspace/private-project-name-wt",
  project: { id: "project-secret-id" },
  serverUrl: new URL("http://user:pass@127.0.0.1:4096/path"),
};

describe("plugin config and identity", () => {
  test("derives hash-only session metadata when no explicit session is configured", () => {
    const identity = derivePluginIdentity(ctx, { USER: "Alice Example" });
    expect(identity.owner).toBe("alice-example");
    expect(identity.session).toMatch(/^session-[0-9a-f]{12}$/);
    expect(identity.metadata.opencode_identity_source).toBe("hashed-directory");
    expect(JSON.stringify(identity.metadata)).not.toContain("private-project-name");
    expect(identity.metadata.opencode_server_origin).toBe("http://127.0.0.1:4096");
  });

  test("uses explicit owner/session and validates plugin runtime numbers", () => {
    const resolved = resolvePluginConfig(ctx, {
      NATS_URL: "nats://demo:4222",
      SYNADIA_OPENCODE_OWNER: "Team A",
      SYNADIA_OPENCODE_SESSION: "Frontend Main",
      OPENCODE_PERMISSION_POLICY: "reject",
      SYNADIA_OPENCODE_HEARTBEAT_INTERVAL_S: "5",
      SYNADIA_OPENCODE_KEEPALIVE_INTERVAL_S: "7",
    });
    expect(resolved.config.nats.url).toBe("nats://demo:4222");
    expect(resolved.config.agent.owner).toBe("team-a");
    expect(resolved.config.agent.name).toBe("frontend-main");
    expect(resolved.config.opencode.mode).toBe("plugin");
    expect(resolved.config.opencode.permissionPolicy).toBe("reject");
    expect(resolved.config.agent.heartbeatIntervalS).toBe(5);
    expect(resolved.config.agent.keepaliveIntervalS).toBe(7);
  });

  test("plugin session: SYNADIA_OPENCODE_NAME (canonical) beats the *_SESSION aliases", () => {
    const identity = derivePluginIdentity(ctx, {
      SYNADIA_OPENCODE_NAME: "canonical",
      SYNADIA_OPENCODE_SESSION: "alias",
      SYNADIA_NAME: "fleet-canonical",
      SYNADIA_SESSION: "fleet-alias",
    });
    expect(identity.session).toBe("canonical");
    expect(identity.metadata.opencode_identity_source).toBe("explicit");

    const fleetCanonical = derivePluginIdentity(ctx, {
      SYNADIA_NAME: "fleet-canonical",
      SYNADIA_SESSION: "fleet-alias",
    });
    expect(fleetCanonical.session).toBe("fleet-canonical");
  });

  test("rejects invalid plugin permission policy", () => {
    expect(() => resolvePluginConfig(ctx, { OPENCODE_PERMISSION_POLICY: "maybe" })).toThrow("OPENCODE_PERMISSION_POLICY must be query, local, or reject");
  });
});

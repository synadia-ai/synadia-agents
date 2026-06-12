import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG_PATH, loadConfigFromSources, parseArgs, renderConfigTemplate } from "../src/config.js";

describe("config", () => {
  test("parses CLI flags", () => {
    const flags = parseArgs(["start", "--owner", "alice", "--session", "project-main", "--base-url", "http://127.0.0.1:4096", "--permission-policy", "reject"]);
    expect(flags.command).toBe("start");
    expect(flags.owner).toBe("alice");
    expect(flags.name).toBe("project-main");
    expect(flags.baseUrl).toBe("http://127.0.0.1:4096");
    expect(flags.permissionPolicy).toBe("reject");
  });

  test("does not expose a fake custom OpenCode binary path knob", () => {
    expect(() => parseArgs(["start", "--opencode-path", "/tmp/opencode"])).toThrow("unknown flag --opencode-path");
    const cfg = loadConfigFromSources({
      argv: ["start"],
      env: { USER: "alice", OPENCODE_BIN: "/tmp/opencode" },
      readFile: () => `[opencode]\nopencode_path = "/tmp/from-file"\npath = "/tmp/from-path"\n`,
      cwd: "/tmp/project-main",
    });
    expect("opencodePath" in cfg.opencode).toBe(false);
    expect(renderConfigTemplate()).not.toContain("opencode_path");
  });

  test("CLI overrides env, file, and defaults", () => {
    const file = `[nats]\nurl = "nats://file:4222"\n\n[agent]\nowner = "file-owner"\nname = "file-name"\n\n[opencode]\nbase_url = "http://file.example"\npermission_policy = "local"\n`;
    const cfg = loadConfigFromSources({
      argv: ["start", "--owner", "cli-owner", "--session", "cli-name", "--base-url", "http://cli.example", "--permission-policy", "reject"],
      env: {
        USER: "env-user",
        SYNADIA_OPENCODE_OWNER: "env-owner",
        SYNADIA_OPENCODE_SESSION: "env-name",
        OPENCODE_SERVER_URL: "http://env.example",
        OPENCODE_PERMISSION_POLICY: "query",
      },
      readFile: () => file,
      cwd: "/tmp/project-name",
    });
    expect(cfg.agent.owner).toBe("cli-owner");
    expect(cfg.agent.name).toBe("cli-name");
    expect(cfg.opencode.baseUrl).toBe("http://cli.example");
    expect(cfg.opencode.mode).toBe("attached");
    expect(cfg.opencode.permissionPolicy).toBe("reject");
  });

  test("identity chain: per-agent beats fleet-wide beats file; SYNADIA_OPENCODE_NAME beats _SESSION", () => {
    const file = `[agent]\nowner = "file-owner"\nname = "file-name"\n`;
    const perAgent = loadConfigFromSources({
      argv: ["start"],
      env: {
        USER: "env-user",
        SYNADIA_OPENCODE_OWNER: "per-agent",
        SYNADIA_OWNER: "fleet",
        SYNADIA_OPENCODE_NAME: "canonical-name",
        SYNADIA_OPENCODE_SESSION: "alias-name",
        SYNADIA_NAME: "fleet-name",
      },
      readFile: () => file,
      cwd: "/tmp/project-x",
    });
    expect(perAgent.agent.owner).toBe("per-agent");
    expect(perAgent.agent.name).toBe("canonical-name");

    const fleet = loadConfigFromSources({
      argv: ["start"],
      env: { USER: "env-user", SYNADIA_OWNER: "fleet", SYNADIA_NAME: "fleet-name" },
      readFile: () => file,
      cwd: "/tmp/project-x",
    });
    expect(fleet.agent.owner).toBe("fleet");
    expect(fleet.agent.name).toBe("fleet-name");
  });

  test("env overrides file for NATS creds and carries them without printing content", () => {
    const file = `[nats]\ncreds = "/file.creds"\n`;
    const cfg = loadConfigFromSources({
      argv: ["start"],
      env: { USER: "alice", NATS_CREDS: "/env.creds" },
      readFile: () => file,
      cwd: "/tmp/project-main",
    });
    expect(cfg.nats.creds).toBe("/env.creds");
  });

  test("baseUrl selects attached mode and missing baseUrl selects managed mode", () => {
    const attached = loadConfigFromSources({ argv: ["start", "--base-url", "http://127.0.0.1:4096"], env: { USER: "alice" }, readFile: () => "", cwd: "/tmp/project-main" });
    expect(attached.opencode.mode).toBe("attached");
    const managed = loadConfigFromSources({ argv: ["start"], env: { USER: "alice" }, readFile: () => "", cwd: "/tmp/project-main" });
    expect(managed.opencode.mode).toBe("managed");
  });

  test("strips inline TOML comments before parsing numeric fields", () => {
    const file = `[agent]\nheartbeat_interval_s = 30 # seconds\nkeepalive_interval_s = 45 # seconds\n\n[opencode]\nport = 4096 # default\npermission_timeout_ms = 300000 # ms\n`;
    const cfg = loadConfigFromSources({ argv: ["start"], env: { USER: "alice" }, readFile: () => file, cwd: "/tmp/project-main" });
    expect(cfg.agent.heartbeatIntervalS).toBe(30);
    expect(cfg.agent.keepaliveIntervalS).toBe(45);
    expect(cfg.opencode.port).toBe(4096);
    expect(cfg.opencode.permissionTimeoutMs).toBe(300000);
  });

  test("rejects invalid numeric config values", () => {
    const file = `[opencode]\nport = nope\n`;
    expect(() => loadConfigFromSources({ argv: ["start"], env: { USER: "alice" }, readFile: () => file, cwd: "/tmp/project-main" })).toThrow("opencode.port must be a positive number");
  });

  test("renders a config template", () => {
    const template = renderConfigTemplate();
    expect(template).toContain("[nats]");
    expect(template).toContain("[agent]");
    expect(template).toContain("[opencode]");
    expect(template).toContain('permission_policy = "query"');
    expect(DEFAULT_CONFIG_PATH).toContain("opencode-nats-channel.toml");
  });
});

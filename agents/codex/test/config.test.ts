import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG_PATH, loadConfigFromSources, parseArgs, renderConfigTemplate } from "../src/config.js";

describe("config", () => {
  test("parses CLI flags", () => {
    const flags = parseArgs(["start", "--owner", "alice", "--session", "project-main", "--mode", "fake", "--permission-policy", "reject"]);
    expect(flags.command).toBe("start");
    expect(flags.owner).toBe("alice");
    expect(flags.session).toBe("project-main");
    expect(flags.mode).toBe("fake");
    expect(flags.permissionPolicy).toBe("reject");
  });

  test("CLI overrides env, file, and defaults", () => {
    const file = `[nats]\nurl = "nats://file:4222"\n\n[agent]\nowner = "file-owner"\nsession = "file-session"\n\n[codex]\nmode = "attached"\npermission_policy = "external-owner"\n`;
    const cfg = loadConfigFromSources({
      argv: ["start", "--owner", "cli-owner", "--session", "cli-session", "--mode", "fake", "--permission-policy", "reject"],
      env: {
        USER: "env-user",
        SYNADIA_CODEX_OWNER: "env-owner",
        SYNADIA_CODEX_SESSION: "env-session",
        SYNADIA_CODEX_MODE: "manager",
        SYNADIA_CODEX_PERMISSION_POLICY: "detect",
      },
      readFile: () => file,
      cwd: "/tmp/project-name",
    });
    expect(cfg.agent.owner).toBe("cli-owner");
    expect(cfg.agent.session).toBe("cli-session");
    expect(cfg.codex.mode).toBe("fake");
    expect(cfg.codex.permissionPolicy).toBe("reject");
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

  test("rejects custom subject token", () => {
    expect(() => loadConfigFromSources({ argv: ["start", "--subject-token", "other"], env: { USER: "alice" }, readFile: () => "", cwd: "/tmp/project-main" })).toThrow("agent.subject_token must be codex");
  });

  test("strips inline TOML comments before parsing numeric and boolean fields", () => {
    const file = `[agent]\nheartbeat_interval_s = 30 # seconds\nkeepalive_interval_s = 45 # seconds\n\n[manager]\nenabled = true # opt in\nwatch_interval_ms = 7500 # ms\nstale_grace_intervals = 3 # polls\n`;
    const cfg = loadConfigFromSources({ argv: ["start"], env: { USER: "alice" }, readFile: () => file, cwd: "/tmp/project-main" });
    expect(cfg.agent.heartbeatIntervalS).toBe(30);
    expect(cfg.agent.keepaliveIntervalS).toBe(45);
    expect(cfg.manager.enabled).toBe(true);
    expect(cfg.manager.watchIntervalMs).toBe(7500);
    expect(cfg.manager.staleGraceIntervals).toBe(3);
  });

  test("rejects invalid numeric and enum config values", () => {
    expect(() => loadConfigFromSources({ argv: ["start"], env: { USER: "alice" }, readFile: () => `[agent]\nheartbeat_interval_s = nope\n`, cwd: "/tmp/project-main" })).toThrow("agent.heartbeat_interval_s must be a positive number");
    expect(() => loadConfigFromSources({ argv: ["start"], env: { USER: "alice" }, readFile: () => `[codex]\nmode = "magic"\n`, cwd: "/tmp/project-main" })).toThrow("codex.mode must be fake, managed, attached, or manager");
  });

  test("renders a config template", () => {
    const template = renderConfigTemplate();
    expect(template).toContain("[nats]");
    expect(template).toContain("[agent]");
    expect(template).toContain("[codex]");
    expect(template).toContain('subject_token = "codex"');
    expect(template).toContain("auto_expose_future_sessions = false");
    expect(template).not.toContain("--auto-expose-future-sessions");
    expect(DEFAULT_CONFIG_PATH).toContain("codex-nats-channel.toml");
  });

  test("manager future exposure defaults off and env can opt in", () => {
    const defaults = loadConfigFromSources({ argv: ["start"], env: { USER: "alice" }, readFile: () => "", cwd: "/tmp/project-main" });
    expect(defaults.manager.autoExposeCurrentSessions).toBe(false);
    expect(defaults.manager.autoExposeFutureSessions).toBe(false);
    const cfg = loadConfigFromSources({
      argv: ["start"],
      env: {
        USER: "alice",
        SYNADIA_CODEX_MANAGER_ENABLED: "true",
        SYNADIA_CODEX_AUTO_EXPOSE_FUTURE_SESSIONS: "true",
        SYNADIA_CODEX_WATCH_INTERVAL_MS: "50",
      },
      readFile: () => "",
      cwd: "/tmp/project-main",
    });
    expect(cfg.manager.enabled).toBe(true);
    expect(cfg.manager.autoExposeFutureSessions).toBe(true);
    expect(cfg.manager.watchIntervalMs).toBe(50);
  });

  test("attach subcommands require endpoint, private thread id, and safe public alias", () => {
    const cfg = loadConfigFromSources({
      argv: ["attach", "doctor", "--endpoint", "unix:///tmp/codex.sock", "--thread-id", "raw-private-thread", "--alias", "safe-alias"],
      env: { USER: "alice" },
      readFile: () => "",
      cwd: "/tmp/project-main",
    });
    expect(parseArgs(["attach", "start", "--endpoint", "unix:///tmp/codex.sock", "--thread-id", "raw-private-thread", "--alias", "safe-alias"]).command).toBe("attach:start");
    expect(cfg.codex.mode).toBe("attached");
    expect(cfg.codex.threadId).toBe("raw-private-thread");
    expect(cfg.codex.publicAlias).toBe("safe-alias");
    expect(cfg.agent.session).toBe("safe-alias");
    expect(cfg.codex.permissionPolicy).toBe("external-owner");
  });

  test("attached mode rejects missing alias and non-loopback websocket without auth", () => {
    expect(() => loadConfigFromSources({ argv: ["attach", "doctor", "--endpoint", "unix:///tmp/codex.sock", "--thread-id", "raw"], env: { USER: "alice" }, readFile: () => "", cwd: "/tmp/project-main" })).toThrow("codex.public_alias");
    expect(() => loadConfigFromSources({ argv: ["attach", "doctor", "--endpoint", "ws://192.0.2.10:9999", "--thread-id", "raw", "--alias", "safe"], env: { USER: "alice" }, readFile: () => "", cwd: "/tmp/project-main" })).toThrow("non-loopback WebSocket attached endpoints require");
    const cfg = loadConfigFromSources({ argv: ["attach", "doctor", "--endpoint", "ws://192.0.2.10:9999", "--endpoint-auth", "not-a-secret-shape", "--thread-id", "raw", "--alias", "safe"], env: { USER: "alice" }, readFile: () => "", cwd: "/tmp/project-main" });
    expect(cfg.codex.endpointAuth).toBe("not-a-secret-shape");
  });
});

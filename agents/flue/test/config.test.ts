import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG_PATH, loadConfigFromSources, parseArgs, renderConfigTemplate } from "../src/config.js";

describe("config", () => {
  test("parses CLI flags", () => {
    const flags = parseArgs(["start", "--owner", "rene", "--name", "support", "--flue-agent", "assistant"]);
    expect(flags.command).toBe("start");
    expect(flags.owner).toBe("rene");
    expect(flags.name).toBe("support");
    expect(flags.flueAgent).toBe("assistant");
  });

  test("CLI overrides env and defaults", () => {
    const cfg = loadConfigFromSources({
      argv: ["start", "--owner", "cli-owner", "--name", "cli-name", "--flue-agent", "cli-agent"],
      env: {
        SYNADIA_FLUE_OWNER: "env-owner",
        SYNADIA_FLUE_NAME: "env-name",
        FLUE_BASE_URL: "http://env.example",
        FLUE_AGENT: "env-agent",
        FLUE_INSTANCE: "env-instance",
      },
      readFile: () => "",
    });
    expect(cfg.agent.owner).toBe("cli-owner");
    expect(cfg.agent.name).toBe("cli-name");
    expect(cfg.flue.agent).toBe("cli-agent");
    expect(cfg.flue.baseUrl).toBe("http://env.example");
    expect(cfg.flue.instance).toBe("env-instance");
  });

  test("renders a config template", () => {
    const template = renderConfigTemplate();
    expect(template).toContain("[nats]");
    expect(template).toContain("[agent]");
    expect(template).toContain("[flue]");
    expect(template).toContain('transport = "http-stream"');
    expect(DEFAULT_CONFIG_PATH).toContain("flue-nats-channel.toml");
  });

  test("defaults to HTTP stream Flue transport", () => {
    const cfg = loadConfigFromSources({ argv: ["start"], env: { USER: "rene" }, readFile: () => "" });
    expect(cfg.flue.transport).toBe("http-stream");
  });

  test("env owner overrides file owner and CLI owner overrides both", () => {
    const file = `[agent]\nowner = "file-owner"\nname = "file-name"\n`;
    const envWins = loadConfigFromSources({
      argv: ["start"],
      env: { SYNADIA_FLUE_OWNER: "env-owner", USER: "user-owner" },
      readFile: () => file,
    });
    expect(envWins.agent.owner).toBe("env-owner");

    const cliWins = loadConfigFromSources({
      argv: ["start", "--owner", "cli-owner"],
      env: { SYNADIA_FLUE_OWNER: "env-owner", USER: "user-owner" },
      readFile: () => file,
    });
    expect(cliWins.agent.owner).toBe("cli-owner");
  });

  test("loads NATS creds from CLI, env, or config file precedence", () => {
    const file = `[nats]\ncreds = "/file.creds"\n`;
    const envWins = loadConfigFromSources({
      argv: ["start"],
      env: { USER: "rene", NATS_CREDS: "/env.creds" },
      readFile: () => file,
    });
    expect(envWins.nats.creds).toBe("/env.creds");

    const cliWins = loadConfigFromSources({
      argv: ["start", "--nats-creds", "/cli.creds"],
      env: { USER: "rene", NATS_CREDS: "/env.creds" },
      readFile: () => file,
    });
    expect(cliWins.nats.creds).toBe("/cli.creds");
  });

  test("strips inline TOML comments before parsing numeric fields", () => {
    const file = `[agent]\nheartbeat_interval_s = 30 # seconds\nkeepalive_interval_s = 45 # seconds\n`;
    const cfg = loadConfigFromSources({
      argv: ["start"],
      env: { USER: "rene" },
      readFile: () => file,
    });

    expect(cfg.agent.heartbeatIntervalS).toBe(30);
    expect(cfg.agent.keepaliveIntervalS).toBe(45);
  });

  test("rejects invalid numeric config values", () => {
    const file = `[agent]\nheartbeat_interval_s = not-a-number\n`;
    expect(() => loadConfigFromSources({
      argv: ["start"],
      env: { USER: "rene" },
      readFile: () => file,
    })).toThrow("agent.heartbeat_interval_s must be a positive number");
  });
});

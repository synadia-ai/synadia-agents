import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG_PATH, loadConfigFromSources, parseArgs, renderConfigTemplate } from "../src/config.js";

describe("config", () => {
  test("parses CLI flags", () => {
    const flags = parseArgs(["start", "--owner", "rene", "--name", "support", "--eve-base-url", "http://cli.example:2000"]);
    expect(flags.command).toBe("start");
    expect(flags.owner).toBe("rene");
    expect(flags.name).toBe("support");
    expect(flags.eveBaseUrl).toBe("http://cli.example:2000");
  });

  test("CLI overrides env and defaults", () => {
    const cfg = loadConfigFromSources({
      argv: ["start", "--owner", "cli-owner", "--name", "cli-name", "--eve-base-url", "http://cli.example"],
      env: {
        SYNADIA_EVE_OWNER: "env-owner",
        SYNADIA_EVE_NAME: "env-name",
        EVE_BASE_URL: "http://env.example",
        EVE_AUTH_TOKEN: "env-token",
      },
      readFile: () => "",
    });
    expect(cfg.agent.owner).toBe("cli-owner");
    expect(cfg.agent.name).toBe("cli-name");
    expect(cfg.eve.baseUrl).toBe("http://cli.example");
    expect(cfg.eve.authToken).toBe("env-token");
  });

  test("renders a config template", () => {
    const template = renderConfigTemplate();
    expect(template).toContain("[nats]");
    expect(template).toContain("[agent]");
    expect(template).toContain("[eve]");
    expect(template).toContain('base_url = "http://127.0.0.1:2000"');
    expect(DEFAULT_CONFIG_PATH).toContain("eve-nats-channel.toml");
  });

  test("defaults target local eve dev with no auth and a 120s ask timeout", () => {
    const cfg = loadConfigFromSources({ argv: ["start"], env: { USER: "rene" }, readFile: () => "" });
    expect(cfg.eve.baseUrl).toBe("http://127.0.0.1:2000");
    expect(cfg.eve.authToken).toBeUndefined();
    expect(cfg.eve.askTimeoutS).toBe(120);
    expect(cfg.agent.subjectToken).toBe("eve");
    expect(cfg.agent.name).toBe("main");
  });

  test("env owner overrides file owner and CLI owner overrides both", () => {
    const file = `[agent]\nowner = "file-owner"\nname = "file-name"\n`;
    const envWins = loadConfigFromSources({
      argv: ["start"],
      env: { SYNADIA_EVE_OWNER: "env-owner", USER: "user-owner" },
      readFile: () => file,
    });
    expect(envWins.agent.owner).toBe("env-owner");

    const cliWins = loadConfigFromSources({
      argv: ["start", "--owner", "cli-owner"],
      env: { SYNADIA_EVE_OWNER: "env-owner", USER: "user-owner" },
      readFile: () => file,
    });
    expect(cliWins.agent.owner).toBe("cli-owner");
  });

  test("per-agent SYNADIA_EVE_* beats fleet-wide SYNADIA_*; fleet-wide beats the file", () => {
    const file = `[agent]\nowner = "file-owner"\nname = "file-name"\n`;
    const perAgentWins = loadConfigFromSources({
      argv: ["start"],
      env: {
        SYNADIA_EVE_OWNER: "per-agent",
        SYNADIA_OWNER: "fleet",
        SYNADIA_EVE_NAME: "per-agent-name",
        SYNADIA_NAME: "fleet-name",
        USER: "user-owner",
      },
      readFile: () => file,
    });
    expect(perAgentWins.agent.owner).toBe("per-agent");
    expect(perAgentWins.agent.name).toBe("per-agent-name");

    const fleetWins = loadConfigFromSources({
      argv: ["start"],
      env: { SYNADIA_OWNER: "fleet", SYNADIA_NAME: "fleet-name", USER: "user-owner" },
      readFile: () => file,
    });
    expect(fleetWins.agent.owner).toBe("fleet");
    expect(fleetWins.agent.name).toBe("fleet-name");
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

  test("reads eve auth token and ask timeout from the [eve] section", () => {
    const file = `[eve]\nbase_url = "http://file.example"\nauth_token = "file-token"\nask_timeout_s = 45\n`;
    const cfg = loadConfigFromSources({ argv: ["start"], env: { USER: "rene" }, readFile: () => file });
    expect(cfg.eve.baseUrl).toBe("http://file.example");
    expect(cfg.eve.authToken).toBe("file-token");
    expect(cfg.eve.askTimeoutS).toBe(45);
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
    const file = `[eve]\nask_timeout_s = not-a-number\n`;
    expect(() => loadConfigFromSources({
      argv: ["start"],
      env: { USER: "rene" },
      readFile: () => file,
    })).toThrow("eve.ask_timeout_s must be a positive number");
  });
});

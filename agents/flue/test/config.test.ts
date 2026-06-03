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
    expect(DEFAULT_CONFIG_PATH).toContain("flue-nats-channel.toml");
  });
});

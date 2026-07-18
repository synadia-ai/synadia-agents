import { describe, expect, test } from "bun:test";
import { loadConfigFromSources } from "@synadia-ai/acp-nats-channel";
import { buildGrokArgv } from "../src/cli.js";

const env = { USER: "alice" };

describe("grok-agent argv pinning", () => {
  test("pins the grok preset and defaults to managed mode", () => {
    const argv = buildGrokArgv(["start"]);
    expect(argv).toEqual(["start", "--agent", "grok", "--mode", "managed"]);
    const cfg = loadConfigFromSources({ argv, env, readFile: () => "", cwd: "/tmp/project-main" });
    expect(cfg.acp.preset).toBe("grok");
    expect(cfg.acp.agentId).toBe("grok");
    expect(cfg.agent.subjectToken).toBe("grok");
    expect(cfg.acp.mode).toBe("managed");
    expect(cfg.acp.bin).toBe("grok");
    expect(cfg.acp.args).toEqual(["agent", "stdio"]);
  });

  test("user flags still win over the injected defaults", () => {
    const argv = buildGrokArgv(["start", "--mode", "fake", "--session", "pinned-test"]);
    const cfg = loadConfigFromSources({ argv, env, readFile: () => "", cwd: "/tmp/project-main" });
    expect(cfg.acp.mode).toBe("fake");
    expect(cfg.agent.session).toBe("pinned-test");
    expect(cfg.acp.preset).toBe("grok");
  });

  test("rejects --agent instead of silently re-targeting", () => {
    expect(() => buildGrokArgv(["start", "--agent", "gemini"])).toThrow("pinned to the grok preset");
  });

  test("passes doctor and configure through with the pin applied", () => {
    expect(buildGrokArgv(["doctor"])[0]).toBe("doctor");
    expect(buildGrokArgv(["configure", "--print-template"])).toContain("--print-template");
    expect(buildGrokArgv([])[0]).toBe("help");
  });
});

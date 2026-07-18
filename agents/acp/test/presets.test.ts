import { describe, expect, test } from "bun:test";
import { ACP_PRESETS, presetKeys, resolvePreset } from "../src/presets.js";

describe("presets", () => {
  test("grok preset spawns `grok agent stdio` with GROK_HOME isolation", () => {
    const grok = resolvePreset("grok");
    expect(grok?.agentId).toBe("grok");
    expect(grok?.subjectToken).toBe("grok");
    expect(grok?.bin).toBe("grok");
    expect(grok?.args).toEqual(["agent", "stdio"]);
    expect(grok?.homeEnvVar).toBe("GROK_HOME");
    expect(grok?.envPrefix).toBe("SYNADIA_GROK");
  });

  test("gemini preset uses the canonical gemini-cli id with the gemini wire token", () => {
    const gemini = resolvePreset("gemini");
    expect(gemini?.agentId).toBe("gemini-cli");
    expect(gemini?.subjectToken).toBe("gemini");
    expect(gemini?.args).toEqual(["--experimental-acp"]);
    expect(gemini?.homeEnvVar).toBeUndefined();
  });

  test("preset listing includes custom", () => {
    expect(resolvePreset("custom")).toBeUndefined();
    expect(presetKeys()).toContain("custom");
    expect(ACP_PRESETS.length).toBeGreaterThanOrEqual(2);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));

describe("package metadata", () => {
  test("uses publishable SDK semver dependencies instead of local file links", () => {
    expect(pkg.dependencies["@synadia-ai/agents"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["@synadia-ai/agent-service"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(JSON.stringify(pkg.dependencies)).not.toContain("file:");
  });

  test("declares an honest Bun TypeScript package surface", () => {
    expect(pkg.bin["opencode-agent"]).toBe("./src/cli.ts");
    expect(pkg.exports["."].import).toBe("./src/index.ts");
    expect(pkg.exports["./opencode-plugin"].import).toBe("./src/plugin/index.ts");
    expect(pkg.scripts["smoke:opencode-plugin-lifecycle"]).toContain("opencode-plugin-lifecycle-smoke.ts");
    expect(pkg.scripts["smoke:opencode-plugin-permission"]).toContain("opencode-plugin-permission-smoke.ts");
    expect(pkg.files).toContain("src");
    expect(pkg.files).toContain("README.md");
    expect(pkg.files).toContain("PLUGIN_FIRST_IMPLEMENTATION_SPEC.md");
    expect(pkg.files).toContain(".env.example");
  });

  test("plugin smoke scripts exercise the production package export, not the spike core", () => {
    const lifecycle = readFileSync(join(import.meta.dir, "..", "scripts", "opencode-plugin-lifecycle-smoke.ts"), "utf8");
    const permission = readFileSync(join(import.meta.dir, "..", "scripts", "opencode-plugin-permission-smoke.ts"), "utf8");
    const productionSmoke = readFileSync(join(import.meta.dir, "..", "scripts", "production-plugin-smoke.ts"), "utf8");
    expect(lifecycle).toContain("./production-plugin-smoke.js");
    expect(permission).toContain("./production-plugin-smoke.js");
    expect(`${lifecycle}\n${permission}`).not.toContain("spikes/plugin-channel");
    expect(productionSmoke).toContain("@synadia-ai/opencode-nats-channel/opencode-plugin");
  });

  test("ships a trackable dotenv example instead of only ignoring local env files", () => {
    const example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    expect(example).toContain("SYNADIA_OPENCODE_OWNER=local");
    expect(example).toContain("SYNADIA_OPENCODE_SESSION=main");
    expect(example).toContain("OPENCODE_PERMISSION_POLICY=query");
    expect(example).not.toMatch(/S[A-Z0-9]{57}/);
  });
});

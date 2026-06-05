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
    expect(pkg.files).toContain("src");
  });
});

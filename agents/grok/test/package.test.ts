import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json";

const changelog = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8");

describe("package metadata", () => {
  test("uses the required published package and binary names", () => {
    expect(packageJson.name).toBe("@synadia-ai/grok-nats-channel");
    expect(packageJson.bin).toEqual({ "grok-agent": "./src/cli.ts" });
    expect(packageJson.publishConfig).toEqual({ access: "public" });
  });

  test("stays a thin wrapper: the ACP channel is the only runtime dependency", () => {
    expect(Object.keys(packageJson.dependencies)).toEqual(["@synadia-ai/acp-nats-channel"]);
  });

  test("documents the pre-publish file: link in the changelog", () => {
    // Pre-publish the dep is a file:../acp link (see CHANGELOG Notes); the
    // release-ladder step that publishes the ACP channel flips it to semver.
    const dep = packageJson.dependencies["@synadia-ai/acp-nats-channel"];
    if (dep.startsWith("file:")) {
      expect(changelog).toContain("file:../acp");
    } else {
      expect(dep).toMatch(/^\^\d+\.\d+\.\d+/);
    }
  });

  test("includes release notes in the publishable package", () => {
    expect(packageJson.files).toContain("CHANGELOG.md");
    expect(changelog).toContain("## [0.1.0]");
  });
});

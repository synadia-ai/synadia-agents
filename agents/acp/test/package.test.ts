import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json";

const changelog = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8");

describe("package metadata", () => {
  test("uses the required published package and binary names", () => {
    expect(packageJson.name).toBe("@synadia-ai/acp-nats-channel");
    expect(packageJson.bin).toEqual({ "acp-agent": "./src/cli.ts" });
    expect(packageJson.publishConfig).toEqual({ access: "public" });
  });

  test("declares protocol and ACP dependencies by semver, not file links", () => {
    expect(packageJson.dependencies["@synadia-ai/agent-service"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(packageJson.dependencies["@synadia-ai/agents"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(packageJson.dependencies["@agentclientprotocol/sdk"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(packageJson.dependencies["@synadia-ai/agent-service"]).not.toContain("file:");
    expect(packageJson.dependencies["@synadia-ai/agents"]).not.toContain("file:");
    expect(packageJson.dependencies["@nats-io/nats-core"]).toBeTruthy();
    expect(packageJson.dependencies["@nats-io/transport-node"]).toBeTruthy();
  });

  test("includes release notes in the publishable package", () => {
    expect(packageJson.files).toContain("CHANGELOG.md");
    expect(changelog).toContain("## [0.1.0]");
    expect(changelog).toContain("ACP");
  });

  test("keeps the smoke ladder deterministic (fake fixture, no real agent binary)", () => {
    expect(packageJson.scripts["smoke:protocol"]).toContain("protocol-smoke.ts");
    expect(packageJson.scripts["smoke:acp-fake-runtime"]).toContain("acp-runtime-smoke.ts");
  });
});

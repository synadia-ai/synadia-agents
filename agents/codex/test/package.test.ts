import { describe, expect, test } from "bun:test";
import packageJson from "../package.json";

describe("package metadata", () => {
  test("uses the required published package and binary names", () => {
    expect(packageJson.name).toBe("@synadia-ai/codex-nats-channel");
    expect(packageJson.bin).toEqual({ "codex-agent": "./src/cli.ts" });
    expect(packageJson.publishConfig).toEqual({ access: "public" });
  });

  test("declares protocol dependencies", () => {
    expect(packageJson.dependencies["@synadia-ai/agent-service"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(packageJson.dependencies["@synadia-ai/agents"]).toMatch(/^\^\d+\.\d+\.\d+/);
    expect(packageJson.dependencies["@synadia-ai/agent-service"]).not.toContain("file:");
    expect(packageJson.dependencies["@synadia-ai/agents"]).not.toContain("file:");
    expect(packageJson.dependencies["@nats-io/nats-core"]).toBeTruthy();
    expect(packageJson.dependencies["@nats-io/transport-node"]).toBeTruthy();
  });

  test("keeps the runtime smoke ladder honest about real versus fake Codex boundaries", () => {
    expect(packageJson.scripts["smoke:codex-fake-runtime"]).toContain("codex-runtime-smoke.ts");
    expect(packageJson.scripts["smoke:codex-runtime"]).toContain("smoke:codex-appserver-lifecycle");
    expect(packageJson.scripts["smoke:codex-runtime"]).toContain("smoke:codex-fake-runtime");
  });
});

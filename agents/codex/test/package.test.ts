import { describe, expect, test } from "bun:test";
import packageJson from "../package.json";

describe("package metadata", () => {
  test("uses the required published package and binary names", () => {
    expect(packageJson.name).toBe("@synadia-ai/codex-nats-channel");
    expect(packageJson.bin).toEqual({ "codex-agent": "./src/cli.ts" });
    expect(packageJson.publishConfig).toEqual({ access: "public" });
  });

  test("declares protocol dependencies", () => {
    expect(packageJson.dependencies["@synadia-ai/agent-service"]).toBeTruthy();
    expect(packageJson.dependencies["@synadia-ai/agents"]).toBeTruthy();
    expect(packageJson.dependencies["@nats-io/nats-core"]).toBeTruthy();
    expect(packageJson.dependencies["@nats-io/transport-node"]).toBeTruthy();
  });
});

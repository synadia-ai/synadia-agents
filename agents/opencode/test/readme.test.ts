import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

describe("README plugin-first guidance", () => {
  test("documents the npm install path and Bun requirement", () => {
    expect(readme).toContain("## Prerequisites");
    expect(readme).toContain("Bun must be installed and available on `PATH`");
    expect(readme).toContain("[Bun](https://bun.sh/) installed and available on `PATH`");
    expect(readme).toContain("[OpenCode](https://opencode.ai/) installed and available on `PATH`");
    expect(readme).toContain("A reachable NATS server, or a NATS CLI context");
    expect(readme).toContain("bunx @synadia-ai/opencode-nats-channel plugin install");
    expect(readme).toContain("bunx @synadia-ai/opencode-nats-channel plugin doctor");
    expect(readme).toContain("After a global install, the binary is `opencode-agent`");
    expect(readme).toContain("substitute `bunx @synadia-ai/opencode-nats-channel` for `opencode-agent`");
  });

  test("keeps the public README focused on the OpenCode plugin", () => {
    expect(readme).toContain("The intended user path is plugin-first");
    expect(readme).toContain("@synadia-ai/opencode-nats-channel/opencode-plugin");
    expect(readme).toContain(".opencode/plugins/synadia-channel.ts");
    expect(readme).not.toContain("## Quick start: managed mode");
    expect(readme).not.toContain("## Quick start: attached mode");
    expect(readme).not.toContain("## Multi-session recipe");
    expect(readme).not.toContain("Synadia adapter process");
  });

  test("calls out npm publication as maintainer release work", () => {
    expect(readme).toContain("must be published to npm before the `bunx` install path works");
    expect(readme).toContain("../../README-DEV.md");
  });
});

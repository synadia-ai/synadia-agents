import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

describe("README plugin guidance", () => {
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
    expect(readme).toContain("makes an OpenCode project discoverable and promptable over NATS");
    expect(readme).toContain("Install it in each OpenCode project you want to expose");
    expect(readme).toContain("When OpenCode starts from that project, it loads the plugin automatically");
    expect(readme).toContain("No command needs to be typed inside OpenCode");
    expect(readme).toContain("restart OpenCode after installing the plugin if it was already running");
    expect(readme).toContain("Check the install");
    expect(readme).toContain("cd /path/to/repo");
    expect(readme).toContain("There is no separate “activate plugin” command inside OpenCode");
    expect(readme).toContain("Leave OpenCode running. From another terminal, discover the agent");
    expect(readme).toContain("is the file OpenCode sees at startup");
    expect(readme).toContain("imports the real Synadia channel from the npm package dependency recorded in `.opencode/package.json`");
    expect(readme).toContain("Start OpenCode from the same project directory");
    expect(readme).toContain("For normal terminal use, start the OpenCode TUI");
    expect(readme).toContain("opencode\n```");
    expect(readme).toContain("For a headless/server deployment, start OpenCode's server instead");
    expect(readme).toContain("opencode serve --hostname 127.0.0.1 --port 4096");
    expect(readme).toContain("during startup in either form");
    expect(readme).toContain("@synadia-ai/opencode-nats-channel/opencode-plugin");
    expect(readme).toContain(".opencode/plugins/synadia-channel.ts");
    expect(readme).not.toContain("The intended user path");
    expect(readme).not.toContain("wrapper");
    expect(readme).not.toContain("plugin-first");
    expect(readme).not.toContain("Plugin mode registers");
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

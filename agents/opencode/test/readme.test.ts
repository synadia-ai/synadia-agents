import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

describe("README process-model guidance", () => {
  test("documents published binary Bun requirement", () => {
    expect(readme).toContain("Bun must be installed and available on `PATH`");
    expect(readme).toContain("bunx @synadia-ai/opencode-nats-channel doctor");
  });

  test("distinguishes OpenCode TUI, OpenCode server, and Synadia adapter processes", () => {
    expect(readme).toContain("OpenCode TUI");
    expect(readme).toContain("OpenCode HTTP/SSE server");
    expect(readme).toContain("Synadia adapter process");
    expect(readme).toContain("does not attach to arbitrary terminal TUI processes");
  });

  test("documents a concrete multi-session process recipe", () => {
    expect(readme).toContain("## Multi-session recipe");
    expect(readme).toContain("opencode serve --hostname 127.0.0.1 --port 4096");
    expect(readme).toContain("--opencode-session-id ses_frontend");
    expect(readme).toContain("--opencode-session-id ses_backend");
    expect(readme).toContain("agents.prompt.opencode.team.frontend");
    expect(readme).toContain("agents.prompt.opencode.team.backend");
  });
});

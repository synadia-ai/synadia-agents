import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

// Honesty guards in the codex-channel tradition: the README must not
// overclaim what the adapter does.
describe("README", () => {
  test("documents the grok preset and the custom escape hatch", () => {
    expect(readme).toContain("grok agent stdio");
    expect(readme).toContain("`custom`");
    expect(readme).not.toContain("--experimental-acp"); // gemini preset removed
  });

  test("documents the Antigravity custom-preset route honestly", () => {
    expect(readme).toContain("no native ACP mode yet");
    expect(readme).toContain("--agent custom --agent-id antigravity");
    expect(readme).toContain("review third-party adapters before use");
    // Regression guard: bare acp-agent defaults to fake mode, so the
    // documented start command must carry --mode managed and point the
    // adapter at the locally-authenticated agy.
    expect(readme).toMatch(/--mode managed[\s\S]{0,200}--agent custom --agent-id antigravity/);
    expect(readme).toContain('AGY_BIN="$(which agy)"');
  });

  test("documents running from a repo clone", () => {
    expect(readme).toContain("ln -sf");
    expect(readme).toContain("~/.local/bin/acp-agent");
  });

  test("is honest about attachments", () => {
    expect(readme).toContain("Attachments are not supported");
    expect(readme).toContain("attachments_ok=false");
  });

  test("is honest about crash handling", () => {
    expect(readme).toContain("no automatic restart");
  });

  test("documents home isolation and the auth consequence", () => {
    expect(readme).toContain("GROK_HOME");
    expect(readme).toContain("unauthenticated");
    expect(readme).toContain("--agent-home");
  });

  test("documents all three permission policies", () => {
    expect(readme).toContain("**`reject`** (default)");
    expect(readme).toContain("**`query`**");
    expect(readme).toContain("**`allow`**");
  });

  test("keeps the validation ladder honest about fake versus real agents", () => {
    expect(readme).toContain("smoke:acp-fake-runtime");
    expect(readme).toContain("fake-acp-agent.ts");
    expect(readme).toContain("without any real agent binary");
  });
});

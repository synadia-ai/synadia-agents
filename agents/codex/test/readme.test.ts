import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("README public claims", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  test("documents honest v1 attachment support", () => {
    expect(readme).toContain("attachments_ok=false");
    expect(readme).toContain("Attachments are rejected");
  });

  test("does not claim arbitrary GUI/TUI control or leak private research language", () => {
    expect(readme).not.toMatch(/all Codex windows/i);
    expect(readme).not.toMatch(/all GUI sessions/i);
    expect(readme).not.toMatch(/Kanban|research/i);
    expect(readme).not.toMatch(/thread_[A-Za-z0-9_-]+/);
    expect(readme).not.toMatch(/unix:\/\//);
  });
});

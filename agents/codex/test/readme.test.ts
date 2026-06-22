import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("README public claims", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  test("documents honest v1 attachment support", () => {
    expect(readme).toContain("attachments_ok=false");
    expect(readme).toContain("Attachments are rejected");
  });

  test("documents prerequisites, install, and troubleshooting", () => {
    expect(readme).toContain("## Prerequisites");
    expect(readme).toContain("## Install");
    expect(readme).toContain("## Troubleshooting");
    expect(readme).toContain("npm install -g @synadia-ai/codex-nats-channel");
  });

  test("does not claim arbitrary GUI/TUI control or leak private research language", () => {
    expect(readme).not.toMatch(/all Codex windows/i);
    expect(readme).not.toMatch(/all GUI sessions/i);
    expect(readme).not.toMatch(/Kanban|research|Phase [0-9]/i);
    expect(readme).not.toMatch(/thread_[A-Za-z0-9_-]+/);
    expect(readme).not.toMatch(/\/Users\//);
    expect(readme).not.toMatch(/unix:\/\/\/(?:Users|var|tmp)\//);
  });

  test("documents NATS CLI examples with correct reply semantics", () => {
    expect(readme).toContain("nats --no-context --server nats://127.0.0.1:4222 req '$SRV.INFO.agents' '' --replies=1 --timeout=5s");
    expect(readme).toContain("nats --no-context --server nats://127.0.0.1:4222 req agents.status.codex.local.demo '' --replies=1 --timeout=5s");
    expect(readme).toContain("nats --no-context --server nats://127.0.0.1:4222 req agents.prompt.codex.local.demo 'say hello' --wait-for-empty");
  });
});

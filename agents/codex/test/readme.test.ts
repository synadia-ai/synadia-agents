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

  test("keeps low-UX attached-thread workflow out of public README", () => {
    expect(readme).not.toMatch(/Attached endpoint mode|attached endpoint/i);
    expect(readme).not.toContain("--thread-id");
    expect(readme).not.toContain("--alias");
    expect(readme).not.toContain("public alias");
    expect(readme).not.toContain("smoke:attached-endpoint");
  });

  test("documents live approval harness evidence boundaries", () => {
    expect(readme).toContain("CODEX_ENDPOINT=spawn KEEP_HARNESS_ROOT=1 bun run manual:codex-live-approval -- deny");
    expect(readme).toContain("answers app-server approval requests through the adapter's real `responseFor()` mapping");
    expect(readme).toContain('"approvalMethods":["item/commandExecution/requestApproval"]');
    expect(readme).toContain('"approvalResponses":[{"decision":"decline"}]');
    expect(readme).toContain('"approvalResponses":[{"decision":"accept"}]');
    expect(readme).toContain("`item/fileChange/requestApproval` uses the same accept/decline/cancel decision response shape");
    expect(readme).toContain("It does not prove `item/permissions/requestApproval` unless that exact method appears in `approvalMethods`");
    expect(readme).toContain("uses an explicit empty grant object for deny/cancel");
  });

  test("documents how to create known manager endpoints", () => {
    expect(readme).toContain("To use manager mode, first start or choose a Codex app-server endpoint");
    expect(readme).toContain("create or load at least one Codex session on the endpoint first");
    expect(readme).toContain("complete at least one turn");
    expect(readme).toContain("An empty `codex --remote ...` session is not visible to the manager yet");
    expect(readme).toContain("after you send a prompt and the first turn exists");
    expect(readme).toContain("Future-session mode is different: it keeps sessions that already existed at manager startup private");
    expect(readme).toContain("Then create or open a `codex --remote ws://127.0.0.1:8765` session and send at least one prompt");
    expect(readme).toContain("If you send the prompt before starting this future-session manager, it is no longer future");
    expect(readme).toContain("it creates a real `AgentService` immediately");
    expect(readme).toContain("nats --no-context --server nats://127.0.0.1:4222 service list");
    expect(readme).toContain("nats --no-context --server nats://127.0.0.1:4222 service info agents --json");
    expect(readme).toContain("Type `rescan` in the manager terminal only when you want to force reconciliation now");
    expect(readme).toContain("reports a redacted `endpoint errors` count");
    expect(readme).toContain("is a single shared token applied to every configured manager endpoint");
    expect(readme).toContain("Bun-targeted and publishes TypeScript sources plus a Bun executable entry point");
    expect(readme).toContain("If you start the manager before creating any sessions, it should report zero sessions");
    expect(readme).toContain("Codex desktop app can start its own bundled `codex app-server`");
    expect(readme).toContain("private process-owned IPC");
    expect(readme).toContain("codex app-server --listen ws://127.0.0.1:8765");
    expect(readme).toContain("codex --remote ws://127.0.0.1:8765");
    expect(readme).toContain("codex remote-control start");
    expect(readme).toContain("Use WebSocket endpoints on Windows");
    expect(readme).not.toMatch(/hunt for a random socket path/i);
  });
});

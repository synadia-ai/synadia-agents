import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

describe("README", () => {
  test("declares the thin-wrapper relationship to the ACP channel", () => {
    expect(readme).toContain("thin, grok-pinned front door");
    expect(readme).toContain("@synadia-ai/acp-nats-channel");
  });

  test("documents the permission_mode / query-relay interaction", () => {
    expect(readme).toContain('permission_mode = "always-approve"');
    expect(readme).toContain("§7");
    expect(readme).toContain("decides *when* to ask");
  });

  test("documents all three agent-home strategies", () => {
    expect(readme).toContain("--agent-home ~/.grok");
    expect(readme).toContain("Dedicated authed home");
    expect(readme).toContain("Ephemeral");
  });

  test("carries the live-verified approve and deny evidence", () => {
    expect(readme).toContain("live-verified");
    expect(readme).toContain("file created with the exact content");
    expect(readme).toContain("file not created");
  });

  test("points at the ACP channel for limitations instead of overclaiming", () => {
    expect(readme).toContain("limitations");
    expect(readme).not.toContain("attachments are supported");
  });
});

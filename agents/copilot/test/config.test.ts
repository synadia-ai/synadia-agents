import { describe, expect, test } from "bun:test";

import { instanceName, resolveSettings, sanitizeToken, senderAllowed } from "../src/config.js";
import { describePermission, framePrompt, parseApproval, stageAttachments } from "../src/runtime.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

describe("resolveSettings", () => {
  test("secure defaults: inbound off, localhost, blocking tools, ui permissions", () => {
    const s = resolveSettings({}, { USERNAME: "Ada L" });
    expect(s.inbound.enabled).toBe(false);
    expect(s.inbound.permissions).toBe("ui");
    expect(s.inbound.minSenderTrust).toBe("any");
    expect(s.connectionSource).toEqual({ url: "nats://127.0.0.1:4222" });
    expect(s.agentTools).toBe("blocking");
    expect(s.owner).toBe("ada-l");
    expect(s.disabled).toBe(false);
  });

  test("env wins over the file", () => {
    const s = resolveSettings(
      { url: "nats://file:4222", owner: "fileowner", inbound: { enabled: true, minSenderTrust: "signed" } },
      { NATS_URL: "nats://env:4222", SYNADIA_COPILOT_OWNER: "envowner", SYNADIA_COPILOT_INBOUND: "0" },
    );
    expect(s.connectionSource).toEqual({ url: "nats://env:4222" });
    expect(s.owner).toBe("envowner");
    expect(s.inbound.enabled).toBe(false);
    expect(s.inbound.minSenderTrust).toBe("signed");
  });

  test("an allowlist forces signed senders", () => {
    const s = resolveSettings({}, { SYNADIA_COPILOT_ALLOW_SENDERS: "UABC, ACC.UDEF", NATS_MIN_SENDER_TRUST: "any" });
    expect(s.inbound.allowSenders).toEqual(["UABC", "ACC.UDEF"]);
    expect(s.inbound.minSenderTrust).toBe("signed");
  });

  test("a context beats a file url; creds need a url", () => {
    expect(resolveSettings({ url: "nats://x" }, { NATS_CONTEXT: "prod" }).connectionSource).toEqual({ context: "prod" });
    expect(() => resolveSettings({}, { NATS_CREDS: "/x.creds" })).toThrow(/NATS_URL/);
  });

  test("rejects bad values", () => {
    expect(() => resolveSettings({}, { SYNADIA_COPILOT_INBOUND: "maybe" })).toThrow();
    expect(() => resolveSettings({}, { SYNADIA_COPILOT_PERMISSIONS: "auto" })).toThrow();
    expect(() => resolveSettings({}, { SYNADIA_COPILOT_QUEUE_LIMIT: "0" })).toThrow();
    expect(() => resolveSettings({}, { SYNADIA_COPILOT_TOOL_PREFIX: "bad-prefix" })).toThrow();
  });

  test("redacts url credentials in the label", () => {
    expect(resolveSettings({}, { NATS_URL: "nats://u:secret@h:4222" }).connectionLabel).toBe("nats://***@h:4222");
  });
});

describe("helpers", () => {
  test("instance and token names", () => {
    expect(instanceName({ name: undefined }, "4f3a-9b2c-1d0e-77")).toBe("copilot-4f3a9b2c");
    expect(instanceName({ name: "demo" }, "x")).toBe("demo");
    expect(sanitizeToken("  Foo.Bar*Baz  ")).toBe("foo-bar-baz");
  });

  test("sender allowlist matches full ids and bare user keys", () => {
    expect(senderAllowed(["UKEY"], "ACC.UKEY")).toBe(true);
    expect(senderAllowed(["ACC.UKEY"], "ACC.UKEY")).toBe(true);
    expect(senderAllowed(["OTHER.UKEY"], "ACC.UKEY")).toBe(false);
    expect(senderAllowed(["UOTHER"], "ACC.UKEY")).toBe(false);
  });

  test("prompt framing names the sender", () => {
    const f = framePrompt("do it", "alice (verified)", []);
    expect(f).toContain("sender alice (verified)");
    expect(f.endsWith("\n\ndo it")).toBe(true);
  });

  test("permission questions and answers", () => {
    expect(describePermission({ kind: "shell", fullCommandText: "rm -rf x" })).toContain("(shell) — fullCommandText: rm -rf x");
    expect(parseApproval(" Yes ")).toBe(true);
    expect(parseApproval("no")).toBe(false);
    expect(parseApproval("yes please")).toBe(false);
  });

  test("attachments are staged with safe names", () => {
    const root = mkdtempSync(join(tmpdir(), "stage-test-"));
    try {
      const staged = stageAttachments(root, "r1", [
        { filename: "../../etc/passwd", content: new TextEncoder().encode("a") },
        { filename: "C:\\x\\notes.md", content: new TextEncoder().encode("b") },
        { filename: "notes.md", content: new TextEncoder().encode("c") },
      ]);
      for (const a of staged) {
        expect(dirname(a.path)).toBe(join(root, "r1"));
        expect(existsSync(a.path)).toBe(true);
      }
      expect(staged.map((a) => a.displayName)).toEqual(["passwd", "notes.md", "3-notes.md"]);
      expect(readFileSync(staged[2]!.path, "utf8")).toBe("c");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { permissionPromptText, resolvePermissionRequest, selectPermissionOutcome } from "../src/permissions.js";

const options: PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

const request = (opts: PermissionOption[] = options): RequestPermissionRequest => ({
  sessionId: "sess-1",
  options: opts,
  toolCall: {
    toolCallId: "tc-1",
    title: "touch /tmp/thing",
    kind: "execute",
    rawInput: { command: "touch /tmp/thing" },
  },
});

describe("permission mapping", () => {
  test("approve selects allow_once, falling back to allow_always", () => {
    expect(selectPermissionOutcome(options, "approve")).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    const alwaysOnly = options.filter((o) => o.kind !== "allow_once");
    expect(selectPermissionOutcome(alwaysOnly, "approve")).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
  });

  test("deny selects reject_once; missing options degrade to cancelled", () => {
    expect(selectPermissionOutcome(options, "deny")).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
    expect(selectPermissionOutcome([], "deny")).toEqual({ outcome: { outcome: "cancelled" } });
    expect(selectPermissionOutcome(options, "cancel")).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("reject policy denies without consulting a sink", async () => {
    let asked = false;
    const outcome = await resolvePermissionRequest(request(), {
      policy: "reject",
      sink: () => { asked = true; return "approve"; },
    });
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
    expect(asked).toBe(false);
  });

  test("allow policy approves without consulting a sink", async () => {
    const outcome = await resolvePermissionRequest(request(), { policy: "allow" });
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  test("query policy relays through the sink and maps the decision", async () => {
    const prompts: string[] = [];
    const outcome = await resolvePermissionRequest(request(), {
      policy: "query",
      sink: (prompt) => { prompts.push(prompt); return "approve"; },
    });
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    expect(prompts[0]).toContain("touch /tmp/thing");
  });

  test("query sink timeout degrades to cancelled", async () => {
    const outcome = await resolvePermissionRequest(request(), {
      policy: "query",
      sink: () => new Promise(() => { /* never resolves */ }),
      timeoutMs: 20,
    });
    expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("prompt text includes the tool call and truncated raw input", () => {
    const text = permissionPromptText(request());
    expect(text).toContain("touch /tmp/thing");
    expect(text).toContain("[execute]");
    expect(text).toContain("approve to allow once");
    const huge = request();
    const withHugeInput: RequestPermissionRequest = {
      ...huge,
      toolCall: { ...huge.toolCall, rawInput: { blob: "x".repeat(10_000) } },
    };
    expect(permissionPromptText(withHugeInput).length).toBeLessThan(1500);
  });
});

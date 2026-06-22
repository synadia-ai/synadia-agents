import { describe, expect, test } from "bun:test";
import { defaultServerRequestResponse } from "../src/codex-jsonrpc.js";
import { permissionPrompt, responseFor, resolvePermissionRequest } from "../src/permissions.js";

describe("Codex permission response mapping", () => {
  test("maps command and file decisions to Codex accept/decline/cancel values", () => {
    expect(responseFor("item/commandExecution/requestApproval", "approve")).toEqual({ decision: "accept" });
    expect(responseFor("item/commandExecution/requestApproval", "deny")).toEqual({ decision: "decline" });
    expect(responseFor("item/fileChange/requestApproval", "cancel")).toEqual({ decision: "cancel" });
  });

  test("grants additional permissions only on approve", () => {
    expect(responseFor("item/permissions/requestApproval", "approve")).toEqual({ permissions: {}, scope: "turn", strictAutoReview: true });
    expect(responseFor("item/permissions/requestApproval", "deny")).toEqual({ permissions: {}, scope: "turn", strictAutoReview: false });
    expect(responseFor("item/permissions/requestApproval", "cancel")).toEqual({ permissions: {}, scope: "turn", strictAutoReview: false });
  });

  test("default server request handling cancels permissions rather than granting access", () => {
    expect(defaultServerRequestResponse("item/permissions/requestApproval")).toEqual({ permissions: {}, scope: "turn", strictAutoReview: false });
  });

  test("resolvePermissionRequest defaults to cancel when no sink is configured", async () => {
    await expect(resolvePermissionRequest({ method: "item/permissions/requestApproval", params: { reason: "more access" } })).resolves.toEqual({ permissions: {}, scope: "turn", strictAutoReview: false });
  });

  test("permission prompts reuse shared private-value redaction", () => {
    const prompt = permissionPrompt({ method: "item/commandExecution/requestApproval", params: { cwd: "/home/alice/private/project", socket: "unix:///Users/alice/private/codex.sock" } });
    expect(prompt).not.toContain("/home/alice/private/project");
    expect(prompt).not.toContain("unix:///Users/alice/private/codex.sock");
    expect(prompt).toContain("[REDACTED]");
  });
});

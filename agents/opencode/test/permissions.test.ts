import { describe, expect, test } from "bun:test";
import { formatPermissionQuestion, mapQueryReplyToPermissionDecision, permissionQuestionFromEvent, policyDecision } from "../src/permissions.js";

describe("permissions", () => {
  test("reject policy rejects immediately", () => {
    expect(policyDecision("reject")).toEqual({ reply: "reject", message: "Rejected by OpenCode NATS adapter permission_policy=reject" });
    expect(policyDecision("query")).toBeNull();
  });

  test("maps protocol query replies to OpenCode permission replies", () => {
    expect(mapQueryReplyToPermissionDecision("always")).toEqual({ reply: "always" });
    expect(mapQueryReplyToPermissionDecision("no")).toEqual({ reply: "reject", message: "Rejected by protocol query reply" });
    expect(mapQueryReplyToPermissionDecision("yes")).toEqual({ reply: "once" });
    expect(mapQueryReplyToPermissionDecision(undefined)).toEqual({ reply: "once" });
  });

  test("formats compact permission questions", () => {
    expect(formatPermissionQuestion({ tool: "bash", action: "run", description: "ls" })).toContain("OpenCode requests permission for bash (run)");
  });

  test("formats real OpenCode permission events with permission kind, ids, and metadata", () => {
    const question = permissionQuestionFromEvent({
      type: "permission.asked",
      properties: {
        id: "per_test",
        sessionID: "ses_test",
        permission: "external_directory",
        metadata: {
          command: "rm /tmp/scoped/delete-me.txt",
          description: "Remove specific test file",
        },
      },
    });
    expect(question).toContain("OpenCode requests permission for external_directory (Remove specific test file)");
    expect(question).toContain("OpenCode permission id: per_test");
    expect(question).toContain("OpenCode session id: ses_test");
    expect(question).toContain("rm /tmp/scoped/delete-me.txt");
  });
});

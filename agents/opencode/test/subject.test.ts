import { describe, expect, test } from "bun:test";
import { buildHeartbeatSubject, buildPromptSubject, buildStatusSubject, requireSubjectToken, sanitizeDerivedSubjectToken } from "../src/subject.js";

describe("subject helpers", () => {
  test("sanitizes derived defaults only", () => {
    expect(sanitizeDerivedSubjectToken("Alice Demo AI!")).toBe("alice-demo-ai");
    expect(sanitizeDerivedSubjectToken("--Already_OK--")).toBe("already_ok");
  });

  test("rejects unsafe user-supplied subject tokens instead of rewriting routes", () => {
    for (const bad of ["", ".", "owner.name", "with space", "*", ">", "ümlaut"]) {
      expect(() => requireSubjectToken(bad, "token")).toThrow();
    }
  });

  test("builds protocol subjects", () => {
    expect(buildPromptSubject("opencode", "alice", "project-main")).toBe("agents.prompt.opencode.alice.project-main");
    expect(buildStatusSubject("opencode", "alice", "project-main")).toBe("agents.status.opencode.alice.project-main");
    expect(buildHeartbeatSubject("opencode", "alice", "project-main")).toBe("agents.hb.opencode.alice.project-main");
  });
});

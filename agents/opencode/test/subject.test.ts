import { describe, expect, test } from "bun:test";
import { buildHeartbeatSubject, buildPromptSubject, buildStatusSubject, requireSubjectToken, sanitizeDerivedSubjectToken } from "../src/subject.js";

describe("subject helpers", () => {
  test("sanitizes derived defaults only", () => {
    expect(sanitizeDerivedSubjectToken("Rene Rocks AI!")).toBe("rene-rocks-ai");
    expect(sanitizeDerivedSubjectToken("--Already_OK--")).toBe("already_ok");
  });

  test("rejects unsafe user-supplied subject tokens instead of rewriting routes", () => {
    for (const bad of ["", ".", "owner.name", "with space", "*", ">", "ümlaut"]) {
      expect(() => requireSubjectToken(bad, "token")).toThrow();
    }
  });

  test("builds protocol subjects", () => {
    expect(buildPromptSubject("opencode", "rene", "labrowser")).toBe("agents.prompt.opencode.rene.labrowser");
    expect(buildStatusSubject("opencode", "rene", "labrowser")).toBe("agents.status.opencode.rene.labrowser");
    expect(buildHeartbeatSubject("opencode", "rene", "labrowser")).toBe("agents.hb.opencode.rene.labrowser");
  });
});

import { describe, expect, test } from "bun:test";
import { buildHeartbeatSubject, buildPromptSubject, buildStatusSubject, requireSubjectToken, sanitizeDerivedSubjectToken } from "../src/subject.js";

describe("subjects", () => {
  test("builds codex protocol subjects", () => {
    expect(buildPromptSubject("codex", "alice", "main")).toBe("agents.prompt.codex.alice.main");
    expect(buildStatusSubject("codex", "alice", "main")).toBe("agents.status.codex.alice.main");
    expect(buildHeartbeatSubject("codex", "alice", "main")).toBe("agents.hb.codex.alice.main");
  });

  test("validates user supplied tokens strictly", () => {
    expect(requireSubjectToken("project-main_1", "agent.session")).toBe("project-main_1");
    expect(() => requireSubjectToken("Project Main", "agent.session")).toThrow("agent.session must match");
    expect(() => requireSubjectToken("", "agent.session")).toThrow("agent.session must not be empty");
  });

  test("sanitizes derived defaults only", () => {
    expect(sanitizeDerivedSubjectToken("Project Main!")).toBe("project-main");
  });
});

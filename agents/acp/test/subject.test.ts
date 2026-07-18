import { describe, expect, test } from "bun:test";
import { buildHeartbeatSubject, buildPromptSubject, buildStatusSubject, requireSubjectToken, sanitizeDerivedSubjectToken } from "../src/subject.js";

describe("subjects", () => {
  test("builds v0.3 verb-first subjects", () => {
    expect(buildPromptSubject("grok", "alice", "main")).toBe("agents.prompt.grok.alice.main");
    expect(buildStatusSubject("grok", "alice", "main")).toBe("agents.status.grok.alice.main");
    expect(buildHeartbeatSubject("grok", "alice", "main")).toBe("agents.hb.grok.alice.main");
  });

  test("rejects invalid supplied tokens instead of rewriting them", () => {
    expect(() => requireSubjectToken("Not.Valid", "agent.owner")).toThrow("agent.owner");
    expect(() => requireSubjectToken("", "agent.session")).toThrow("must not be empty");
  });

  test("sanitizes derived defaults only", () => {
    expect(sanitizeDerivedSubjectToken("My Project (v2)")).toBe("my-project-v2");
    expect(sanitizeDerivedSubjectToken("---")).toBe("");
  });
});

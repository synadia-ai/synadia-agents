import { describe, expect, it } from "vitest";
import {
  AgentSubject,
  assertValidToken,
  InvalidSubjectTokenError,
  isHeartbeatSubject,
  isRecommendedToken,
  parseAgentSubject,
  RESERVED_VERBS,
  SUBJECT_ROOT,
  VERB_ATTACHMENTS,
  VERB_HEARTBEAT,
  VERB_PROMPT,
  VERB_STATUS,
} from "../../src/subjects.js";

describe("assertValidToken", () => {
  it("accepts valid tokens", () => {
    for (const ok of ["alice", "my-agent", "v1_0", "agent42", "synadia-com-2"]) {
      expect(() => assertValidToken(ok, "name")).not.toThrow();
    }
  });

  it.each([
    ["empty", ""],
    ["leading $", "$sys"],
    ["dot", "a.b"],
    ["wildcard *", "a*b"],
    ["tail wildcard", "a>"],
    ["space", "a b"],
    ["tab", "a\tb"],
    ["NUL", "a\0b"],
  ])("rejects %s", (_label, token) => {
    expect(() => assertValidToken(token, "name")).toThrow(InvalidSubjectTokenError);
  });
});

describe("isRecommendedToken", () => {
  it("returns true for the recommended charset", () => {
    expect(isRecommendedToken("alice")).toBe(true);
    expect(isRecommendedToken("my-agent_v2")).toBe(true);
  });

  it("returns false for uppercase or disallowed chars", () => {
    expect(isRecommendedToken("Alice")).toBe(false);
    expect(isRecommendedToken("my.agent")).toBe(false);
  });

  it("returns false for tokens over 63 chars", () => {
    expect(isRecommendedToken("a".repeat(64))).toBe(false);
    expect(isRecommendedToken("a".repeat(63))).toBe(true);
  });
});

describe("verb constants (§2 v0.3)", () => {
  it("declares the canonical verb tokens", () => {
    expect(VERB_PROMPT).toBe("prompt");
    expect(VERB_HEARTBEAT).toBe("hb");
    expect(VERB_STATUS).toBe("status");
    expect(VERB_ATTACHMENTS).toBe("attachments");
  });

  it("collects them into RESERVED_VERBS", () => {
    expect(RESERVED_VERBS.has("prompt")).toBe(true);
    expect(RESERVED_VERBS.has("hb")).toBe(true);
    expect(RESERVED_VERBS.has("status")).toBe(true);
    expect(RESERVED_VERBS.has("attachments")).toBe(true);
    expect(RESERVED_VERBS.has("spawn")).toBe(false);
  });

  it("declares the subject root", () => {
    expect(SUBJECT_ROOT).toBe("agents");
  });
});

describe("AgentSubject (§2 v0.3 — verb-first)", () => {
  it("builds the prompt / heartbeat / status subjects", () => {
    const s = AgentSubject.new("claude-code", "alice", "session-1");
    expect(s.agent).toBe("claude-code");
    expect(s.owner).toBe("alice");
    expect(s.name).toBe("session-1");
    expect(s.prompt).toBe("agents.prompt.claude-code.alice.session-1");
    expect(s.heartbeat).toBe("agents.hb.claude-code.alice.session-1");
    expect(s.status).toBe("agents.status.claude-code.alice.session-1");
  });

  it("rejects invalid tokens at construction time", () => {
    expect(() => AgentSubject.new("", "alice", "n")).toThrow(InvalidSubjectTokenError);
    expect(() => AgentSubject.new("agent", "$sys", "n")).toThrow(InvalidSubjectTokenError);
    expect(() => AgentSubject.new("agent", "alice", "a.b")).toThrow(InvalidSubjectTokenError);
    expect(() => AgentSubject.new("agent", "alice", "a*")).toThrow(InvalidSubjectTokenError);
    expect(() => AgentSubject.new("agent", "alice", "a\0b")).toThrow(InvalidSubjectTokenError);
  });

  it("subjects survive multi-segment names that pass MUST validation", () => {
    // `my-agent_v2` is recommended-set; valid in NATS subjects.
    const s = AgentSubject.new("my-agent_v2", "owner-1", "sess_42");
    expect(s.prompt).toBe("agents.prompt.my-agent_v2.owner-1.sess_42");
  });

  describe("subjectToken override", () => {
    it("defaults the subject's 3rd token to `agent` when no override is given", () => {
      const s = AgentSubject.new("claude-code", "alice", "s1");
      expect(s.agent).toBe("claude-code");
      expect(s.subjectToken).toBe("claude-code");
    });

    it("uses the override on the wire while keeping `agent` for metadata", () => {
      const s = AgentSubject.new("claude-code", "alice", "s1", { subjectToken: "cc" });
      expect(s.agent).toBe("claude-code");
      expect(s.subjectToken).toBe("cc");
      expect(s.prompt).toBe("agents.prompt.cc.alice.s1");
      expect(s.heartbeat).toBe("agents.hb.cc.alice.s1");
      expect(s.status).toBe("agents.status.cc.alice.s1");
    });

    it("validates the override against §2 MUST rules", () => {
      expect(() => AgentSubject.new("claude-code", "alice", "s1", { subjectToken: "" })).toThrow(
        InvalidSubjectTokenError,
      );
      expect(() =>
        AgentSubject.new("claude-code", "alice", "s1", { subjectToken: "$sys" }),
      ).toThrow(InvalidSubjectTokenError);
      expect(() => AgentSubject.new("claude-code", "alice", "s1", { subjectToken: "c.c" })).toThrow(
        InvalidSubjectTokenError,
      );
    });
  });
});

describe("parseAgentSubject", () => {
  it("parses prompt subjects by default", () => {
    const s = parseAgentSubject("agents.prompt.cc.alice.s1");
    expect(s).not.toBeNull();
    expect(s!.agent).toBe("cc");
    expect(s!.owner).toBe("alice");
    expect(s!.name).toBe("s1");
  });

  it("returns null on wrong root or wrong verb", () => {
    expect(parseAgentSubject("foo.prompt.cc.alice.s1")).toBeNull();
    expect(parseAgentSubject("agents.hb.cc.alice.s1")).toBeNull(); // expecting prompt by default
    expect(parseAgentSubject("agents.prompt.cc.alice.s1.extra")).toBeNull();
    expect(parseAgentSubject("agents.prompt.cc.alice")).toBeNull();
  });

  it("parses heartbeat subjects when verb is overridden", () => {
    const s = parseAgentSubject("agents.hb.pi.bob.session", { verb: VERB_HEARTBEAT });
    expect(s).not.toBeNull();
    expect(s!.agent).toBe("pi");
    expect(s!.owner).toBe("bob");
    expect(s!.name).toBe("session");
  });

  it("parses status subjects when verb is overridden", () => {
    const s = parseAgentSubject("agents.status.dspy.user.react", { verb: VERB_STATUS });
    expect(s).not.toBeNull();
    expect(s!.name).toBe("react");
  });

  it("returns null when token validation fails", () => {
    // `$sys` would fail token validation if it survived the verb position;
    // here it's the owner.
    expect(parseAgentSubject("agents.prompt.cc.$sys.s1")).toBeNull();
  });
});

describe("isHeartbeatSubject", () => {
  it("is true for the v0.3 heartbeat shape", () => {
    expect(isHeartbeatSubject("agents.hb.cc.alice.s1")).toBe(true);
    expect(isHeartbeatSubject("agents.hb.pi.bob.session-1")).toBe(true);
  });

  it("is false for prompt / status / wrong shapes", () => {
    expect(isHeartbeatSubject("agents.prompt.cc.alice.s1")).toBe(false);
    expect(isHeartbeatSubject("agents.status.cc.alice.s1")).toBe(false);
    expect(isHeartbeatSubject("agents.cc.alice.s1.heartbeat")).toBe(false); // pre-v0.3 shape
    expect(isHeartbeatSubject("agents.hb.cc.alice")).toBe(false); // wrong token count
    expect(isHeartbeatSubject("agents.hb.cc.alice.s1.extra")).toBe(false);
  });
});

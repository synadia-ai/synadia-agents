import { describe, expect, it } from "vitest";
import {
  assertValidToken,
  InvalidSubjectTokenError,
  isRecommendedToken,
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

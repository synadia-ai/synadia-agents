import { describe, expect, test } from "bun:test";
import { resolveOwner, sanitizeSubjectToken } from "../src/subject.js";

describe("subject helpers", () => {
  test("sanitizes recommended subject tokens", () => {
    expect(sanitizeSubjectToken("Rene Rocks AI!")).toBe("rene-rocks-ai");
    expect(sanitizeSubjectToken("--Already_OK--")).toBe("already_ok");
  });

  test("falls back to unknown when selected owner sanitizes empty", () => {
    expect(resolveOwner("!!!", "env-owner", "user")).toBe("unknown");
  });

  test("uses explicit/env/user owner precedence", () => {
    expect(resolveOwner("Explicit Owner", "env-owner", "user")).toBe("explicit-owner");
    expect(resolveOwner(undefined, "Env Owner", "user")).toBe("env-owner");
    expect(resolveOwner(undefined, undefined, "Local User")).toBe("local-user");
  });
});

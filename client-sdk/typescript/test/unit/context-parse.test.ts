import { describe, expect, it } from "vitest";
import {
  assertValidContextName,
  ContextParseError,
  parseContextFile,
  splitUrls,
} from "../../src/internal/context-parse.js";

describe("parseContextFile", () => {
  it("parses a full context file", () => {
    const ctx = parseContextFile(
      JSON.stringify({
        description: "production",
        url: "nats://a:4222,nats://b:4222",
        creds: "/home/alice/.nkeys/prod.creds",
        user: "",
        password: "",
      }),
    );
    expect(ctx.description).toBe("production");
    expect(ctx.url).toBe("nats://a:4222,nats://b:4222");
    expect(ctx.creds).toBe("/home/alice/.nkeys/prod.creds");
  });

  it("preserves unknown fields for forward compatibility", () => {
    const ctx = parseContextFile(JSON.stringify({ url: "nats://foo", future_field: "xyz" }));
    expect(ctx["future_field"]).toBe("xyz");
  });

  it("throws ContextParseError on invalid JSON", () => {
    expect(() => parseContextFile("not json")).toThrow(ContextParseError);
  });

  it("throws on JSON that isn't an object", () => {
    expect(() => parseContextFile("[1, 2, 3]")).toThrow(ContextParseError);
    expect(() => parseContextFile('"a string"')).toThrow(ContextParseError);
    expect(() => parseContextFile("null")).toThrow(ContextParseError);
  });

  it("tolerates an empty object", () => {
    const ctx = parseContextFile("{}");
    expect(ctx.url).toBeUndefined();
  });
});

describe("assertValidContextName", () => {
  it("accepts ordinary names", () => {
    for (const ok of ["prod", "staging", "my-context", "my_context", "v1.0"]) {
      expect(() => assertValidContextName(ok)).not.toThrow();
    }
  });

  it.each([
    ["empty", ""],
    ["contains slash", "prod/../etc"],
    ["contains backslash", "prod\\x"],
    ["exactly ..", ".."],
    ["starts with dot", ".hidden"],
    ["contains .. segment", "foo/../bar"],
    ["contains .. segment (backslash)", "foo\\..\\bar"],
  ])("rejects %s", (_label, name) => {
    expect(() => assertValidContextName(name)).toThrow(ContextParseError);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error — runtime guard
    expect(() => assertValidContextName(undefined)).toThrow(ContextParseError);
    // @ts-expect-error — runtime guard
    expect(() => assertValidContextName(42)).toThrow(ContextParseError);
  });
});

describe("splitUrls", () => {
  it("splits a comma-separated list", () => {
    expect(splitUrls("nats://a:4222,nats://b:4222")).toEqual(["nats://a:4222", "nats://b:4222"]);
  });

  it("trims whitespace around entries", () => {
    expect(splitUrls(" nats://a , nats://b ")).toEqual(["nats://a", "nats://b"]);
  });

  it("drops empty entries", () => {
    expect(splitUrls("nats://a,,nats://b,")).toEqual(["nats://a", "nats://b"]);
  });

  it("returns a single-element array for a single URL", () => {
    expect(splitUrls("nats://a:4222")).toEqual(["nats://a:4222"]);
  });

  it("returns [] for an empty string", () => {
    expect(splitUrls("")).toEqual([]);
  });
});

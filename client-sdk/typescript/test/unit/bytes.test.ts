import { describe, expect, it } from "vitest";
import { InvalidSizeError, parseHumanBytes, utf8ByteLength } from "../../src/bytes.js";

describe("parseHumanBytes", () => {
  it.each([
    ["1B", 1],
    ["0B", 0],
    ["1KB", 1024],
    ["512KB", 512 * 1024],
    ["1MB", 1024 * 1024],
    ["4MB", 4 * 1024 * 1024],
    ["1GB", 1024 * 1024 * 1024],
  ])("%s → %d", (input, expected) => {
    expect(parseHumanBytes(input)).toBe(expected);
  });

  it.each([["1mb"], ["1Mb"], ["1MB"], ["1mB"]])("is case-insensitive: %s", (input) => {
    expect(parseHumanBytes(input)).toBe(1024 * 1024);
  });

  it.each([[" 1MB"], ["1MB "], [" 1MB "], ["1 MB"], ["1  MB"]])(
    "tolerates whitespace: %s",
    (input) => {
      expect(parseHumanBytes(input)).toBe(1024 * 1024);
    },
  );

  it.each([
    [""],
    ["1"],
    ["MB"],
    ["1TB"], // TB not in spec
    ["1.5MB"], // no decimals
    ["-1MB"],
    ["0x100MB"],
    ["abc"],
  ])("rejects malformed input: %s", (input) => {
    expect(() => parseHumanBytes(input)).toThrow(InvalidSizeError);
  });

  it("rejects values that would overflow safe integer range", () => {
    expect(() => parseHumanBytes(`${Number.MAX_SAFE_INTEGER}GB`)).toThrow(InvalidSizeError);
  });
});

describe("utf8ByteLength", () => {
  it("returns 0 for empty string", () => {
    expect(utf8ByteLength("")).toBe(0);
  });

  it("counts ASCII as 1 byte per char", () => {
    expect(utf8ByteLength("hello")).toBe(5);
  });

  it("counts multi-byte code points", () => {
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("中")).toBe(3);
    expect(utf8ByteLength("🙂")).toBe(4);
  });
});

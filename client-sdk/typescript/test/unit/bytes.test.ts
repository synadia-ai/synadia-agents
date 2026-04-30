import { describe, expect, it } from "vitest";
import {
  formatHumanBytes,
  InvalidSizeError,
  parseHumanBytes,
  utf8ByteLength,
} from "../../src/bytes.js";

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

describe("formatHumanBytes", () => {
  it.each([
    [0, "0B"],
    [1, "1B"],
    [512 * 1024, "512KB"],
    [1024 * 1024, "1MB"],
    [8 * 1024 * 1024, "8MB"],
    [4 * 1024 * 1024 * 1024, "4GB"],
  ])("%d → %s", (input, expected) => {
    expect(formatHumanBytes(input)).toBe(expected);
  });

  it("picks the largest clean unit", () => {
    // 8MB-worth of bytes formats to "8MB", not "8192KB".
    expect(formatHumanBytes(8 * 1024 * 1024)).toBe("8MB");
  });

  it("falls back to bytes when no clean unit divides evenly", () => {
    expect(formatHumanBytes(1500)).toBe("1500B");
  });

  it.each([0, 1, 512, 1024, 1024 * 1024, 8 * 1024 * 1024])(
    "round-trips with parseHumanBytes: %d",
    (n) => {
      expect(parseHumanBytes(formatHumanBytes(n))).toBe(n);
    },
  );

  it.each([-1, 1.5, NaN, Infinity])("rejects %s", (n) => {
    expect(() => formatHumanBytes(n)).toThrow(InvalidSizeError);
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

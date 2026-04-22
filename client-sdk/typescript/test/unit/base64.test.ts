import { describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "../../src/prompt/envelope.js";

describe("encodeBase64 (RFC 4648 §4)", () => {
  it.each([
    ["", ""],
    ["f", "Zg=="],
    ["fo", "Zm8="],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg=="],
    ["fooba", "Zm9vYmE="],
    ["foobar", "Zm9vYmFy"],
  ])("%s → %s", (input, expected) => {
    const bytes = new TextEncoder().encode(input);
    expect(encodeBase64(bytes)).toBe(expected);
  });

  it("uses standard alphabet (+ and /)", () => {
    // 0xff 0xfe 0xfd → "//79"
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
    expect(encodeBase64(bytes)).toBe("//79");
    // Bytes producing a '+' somewhere
    const plusBytes = new Uint8Array([0x03, 0xef]);
    expect(encodeBase64(plusBytes)).toBe("A+8=");
  });

  it("emits no whitespace", () => {
    const bytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 256));
    expect(encodeBase64(bytes)).not.toMatch(/\s/);
  });

  it("never uses URL-safe characters (- or _)", () => {
    // 0xff 0xff 0xff → "////"
    const bytes = new Uint8Array([0xff, 0xff, 0xff]);
    const out = encodeBase64(bytes);
    expect(out).not.toMatch(/[-_]/);
  });
});

describe("decodeBase64", () => {
  it("round-trips encode→decode for arbitrary bytes", () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 256;
    const roundTrip = decodeBase64(encodeBase64(bytes));
    expect(roundTrip).toEqual(bytes);
  });

  it("decodes the spec reference vectors", () => {
    expect(new TextDecoder().decode(decodeBase64("Zm9vYmFy"))).toBe("foobar");
    expect(new TextDecoder().decode(decodeBase64("Zg=="))).toBe("f");
  });

  it("rejects non-base64 characters", () => {
    expect(() => decodeBase64("!@#$%^&*")).toThrow();
  });
});

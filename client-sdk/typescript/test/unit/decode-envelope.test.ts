import { describe, expect, it } from "vitest";
import {
  decodeBase64,
  decodeEnvelope,
  decodeStrictBase64,
  encodeBase64,
  encodeEnvelope,
} from "../../src/prompt/envelope.js";
import { ProtocolError } from "../../src/errors.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("decodeEnvelope", () => {
  it("decodes a §5.1 JSON envelope without attachments", () => {
    const env = decodeEnvelope(utf8(JSON.stringify({ prompt: "hello" })));
    expect(env.prompt).toBe("hello");
    expect(env.attachments).toBeUndefined();
  });

  it("decodes a §5.3 plain-text shorthand to {prompt: <text>}", () => {
    const env = decodeEnvelope(utf8("plain question"));
    expect(env.prompt).toBe("plain question");
    expect(env.attachments).toBeUndefined();
  });

  it("treats a JSON value that isn't an envelope object as plain text", () => {
    // A bare string, number, or array on the wire is not an envelope per §5.1.
    expect(decodeEnvelope(utf8('"just a string"')).prompt).toBe('"just a string"');
    expect(decodeEnvelope(utf8("[1, 2]")).prompt).toBe("[1, 2]");
    expect(decodeEnvelope(utf8("42")).prompt).toBe("42");
  });

  it("decodes a JSON envelope with valid attachments", () => {
    const content = encodeBase64(utf8("hello bytes"));
    const env = decodeEnvelope(
      utf8(JSON.stringify({ prompt: "see file", attachments: [{ filename: "a.txt", content }] })),
    );
    expect(env.prompt).toBe("see file");
    expect(env.attachments).toHaveLength(1);
    expect(env.attachments![0]!.filename).toBe("a.txt");
    expect(new TextDecoder().decode(env.attachments![0]!.content)).toBe("hello bytes");
  });

  it("rejects envelopes missing a string prompt", () => {
    expect(() => decodeEnvelope(utf8(JSON.stringify({ prompt: 42 })))).toThrow(ProtocolError);
    expect(() => decodeEnvelope(utf8(JSON.stringify({ attachments: [] })))).toThrow(ProtocolError);
  });

  it("rejects envelopes with an empty-string prompt (§5.1 — must be non-empty)", () => {
    // Matches the behaviour of the hand-rolled decoders in pi / claude-code /
    // openclaw which all return 400 for empty prompt strings.
    expect(() => decodeEnvelope(utf8(JSON.stringify({ prompt: "" })))).toThrow(ProtocolError);
  });

  it("rejects non-array attachments", () => {
    expect(() =>
      decodeEnvelope(utf8(JSON.stringify({ prompt: "x", attachments: "not array" }))),
    ).toThrow(ProtocolError);
  });

  it("rejects URL-safe base64 in attachment content (strict §5.2)", () => {
    expect(() =>
      decodeEnvelope(
        utf8(
          JSON.stringify({
            prompt: "x",
            attachments: [{ filename: "a", content: "aGVsbG8-_w==" }],
          }),
        ),
      ),
    ).toThrow(ProtocolError);
  });

  it("rejects unpadded base64 (strict §5.2)", () => {
    expect(() =>
      decodeEnvelope(
        utf8(
          JSON.stringify({
            prompt: "x",
            attachments: [{ filename: "a", content: "aGVsbG8" }], // missing padding
          }),
        ),
      ),
    ).toThrow(ProtocolError);
  });

  it("rejects path-traversal filenames", () => {
    const content = encodeBase64(utf8("x"));
    expect(() =>
      decodeEnvelope(
        utf8(
          JSON.stringify({
            prompt: "x",
            attachments: [{ filename: "../../etc/passwd", content }],
          }),
        ),
      ),
    ).toThrow(ProtocolError);
  });

  it("rejects absolute-path filenames", () => {
    const content = encodeBase64(utf8("x"));
    expect(() =>
      decodeEnvelope(
        utf8(JSON.stringify({ prompt: "x", attachments: [{ filename: "/etc/passwd", content }] })),
      ),
    ).toThrow(ProtocolError);
  });

  it("rejects backslash separators (Windows path-traversal cousin)", () => {
    const content = encodeBase64(utf8("x"));
    expect(() =>
      decodeEnvelope(
        utf8(
          JSON.stringify({
            prompt: "x",
            attachments: [{ filename: "..\\..\\etc\\passwd", content }],
          }),
        ),
      ),
    ).toThrow(ProtocolError);
  });

  it("rejects NUL in filename", () => {
    const content = encodeBase64(utf8("x"));
    expect(() =>
      decodeEnvelope(
        utf8(
          JSON.stringify({
            prompt: "x",
            attachments: [{ filename: "evil\0.txt", content }],
          }),
        ),
      ),
    ).toThrow(ProtocolError);
  });

  it("rejects empty filename", () => {
    const content = encodeBase64(utf8("x"));
    expect(() =>
      decodeEnvelope(
        utf8(JSON.stringify({ prompt: "x", attachments: [{ filename: "", content }] })),
      ),
    ).toThrow(ProtocolError);
  });

  it("round-trips an encoded envelope back to the same data", () => {
    const original = {
      prompt: "see attached",
      attachments: [{ filename: "x.bin", content: utf8("hello bytes") }],
    };
    const wire = encodeEnvelope(original);
    const decoded = decodeEnvelope(wire);
    expect(decoded.prompt).toBe(original.prompt);
    expect(decoded.attachments).toHaveLength(1);
    expect(new TextDecoder().decode(decoded.attachments![0]!.content)).toBe("hello bytes");
  });
});

describe("decodeStrictBase64", () => {
  it("decodes RFC 4648 §4 standard-alphabet padded base64", () => {
    expect(new TextDecoder().decode(decodeStrictBase64("aGVsbG8="))).toBe("hello");
    expect(new TextDecoder().decode(decodeStrictBase64("aGVsbG8gd29ybGQ="))).toBe("hello world");
    expect(decodeStrictBase64("").length).toBe(0);
  });

  it("rejects URL-safe alphabet (`-` / `_`)", () => {
    expect(() => decodeStrictBase64("aGVsbG8-_w==")).toThrow();
  });

  it("rejects unpadded input", () => {
    // Length not divisible by 4.
    expect(() => decodeStrictBase64("aGVsbG8")).toThrow();
  });

  it("rejects whitespace-bearing input", () => {
    expect(() => decodeStrictBase64("aGVs bG8=")).toThrow();
    expect(() => decodeStrictBase64("aGVs\nbG8=")).toThrow();
  });

  it("agrees with the tolerant decodeBase64 on valid input", () => {
    const valid = "aGVsbG8gd29ybGQ=";
    expect(decodeStrictBase64(valid)).toEqual(decodeBase64(valid));
  });
});

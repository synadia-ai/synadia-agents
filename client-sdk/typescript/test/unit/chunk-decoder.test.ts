import { describe, expect, it } from "vitest";
import { decodeChunk } from "../../src/stream/chunk-decoder.js";
import { ProtocolError } from "../../src/errors.js";

function bytes(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

describe("decodeChunk — response", () => {
  it("accepts bare-string `data` (spec §6.3)", () => {
    const decoded = decodeChunk(bytes({ type: "response", data: "Hello." }));
    expect(decoded).toEqual({ type: "response", text: "Hello." });
  });

  it("accepts object `data` with `text`", () => {
    const decoded = decodeChunk(bytes({ type: "response", data: { text: "Hi" } }));
    expect(decoded).toEqual({ type: "response", text: "Hi" });
  });

  it("decodes attachments in response data", () => {
    const decoded = decodeChunk(
      bytes({
        type: "response",
        data: {
          text: "found 2 images",
          attachments: [
            { filename: "a.png", content: "AAAA" },
            { filename: "b.png", content: "BBBB" },
          ],
        },
      }),
    );
    expect(decoded).toMatchObject({
      type: "response",
      text: "found 2 images",
      attachments: [
        { filename: "a.png", content: "AAAA" },
        { filename: "b.png", content: "BBBB" },
      ],
    });
  });

  it("throws ProtocolError when object `data` is missing `text`", () => {
    expect(() => decodeChunk(bytes({ type: "response", data: {} }))).toThrow(ProtocolError);
  });
});

describe("decodeChunk — status", () => {
  it("accepts a status string", () => {
    expect(decodeChunk(bytes({ type: "status", data: "ack" }))).toEqual({
      type: "status",
      status: "ack",
    });
  });

  it("accepts unknown status strings (forward compat §6.4)", () => {
    expect(decodeChunk(bytes({ type: "status", data: "thinking" }))).toEqual({
      type: "status",
      status: "thinking",
    });
  });

  it("throws ProtocolError for non-string data", () => {
    expect(() => decodeChunk(bytes({ type: "status", data: 42 }))).toThrow(ProtocolError);
  });
});

describe("decodeChunk — query", () => {
  it("decodes a query chunk with required fields", () => {
    const decoded = decodeChunk(
      bytes({
        type: "query",
        data: {
          id: "a8f1c2e4-9b63-4d7e-aaaa-112233445566",
          reply_subject: "_INBOX.xyz",
          prompt: "Proceed? (yes/no)",
        },
      }),
    );
    expect(decoded).toEqual({
      type: "query",
      id: "a8f1c2e4-9b63-4d7e-aaaa-112233445566",
      replySubject: "_INBOX.xyz",
      prompt: "Proceed? (yes/no)",
    });
  });

  it("decodes a query chunk with attachments", () => {
    const decoded = decodeChunk(
      bytes({
        type: "query",
        data: {
          id: "q1",
          reply_subject: "_INBOX.r",
          prompt: "Which image?",
          attachments: [{ filename: "preview.jpg", content: "BASE64" }],
        },
      }),
    );
    expect(decoded).toMatchObject({
      type: "query",
      id: "q1",
      attachments: [{ filename: "preview.jpg", content: "BASE64" }],
    });
  });

  it.each([
    [{ reply_subject: "_r", prompt: "p" }], // missing id
    [{ id: "x", prompt: "p" }], // missing reply_subject
    [{ id: "x", reply_subject: "_r" }], // missing prompt
  ])("throws ProtocolError on missing required field: %s", (data) => {
    expect(() => decodeChunk(bytes({ type: "query", data }))).toThrow(ProtocolError);
  });
});

describe("decodeChunk — unknown / malformed", () => {
  it("returns null for unknown `type` (§6.6 silently-drop rule)", () => {
    expect(decodeChunk(bytes({ type: "holograph", data: {} }))).toBeNull();
  });

  it("throws ProtocolError when body is not JSON", () => {
    expect(() => decodeChunk(new TextEncoder().encode("not json"))).toThrow(ProtocolError);
  });

  it("throws ProtocolError when body is JSON but not an object", () => {
    expect(() => decodeChunk(bytes(["array"]))).toThrow(ProtocolError);
    expect(() => decodeChunk(bytes("string"))).toThrow(ProtocolError);
  });

  it("throws ProtocolError when `type` is missing or not a string", () => {
    expect(() => decodeChunk(bytes({ data: "x" }))).toThrow(ProtocolError);
    expect(() => decodeChunk(bytes({ type: 42, data: "x" }))).toThrow(ProtocolError);
  });
});

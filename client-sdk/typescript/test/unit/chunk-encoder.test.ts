import { describe, expect, it } from "vitest";
import { encodeChunk } from "../../src/stream/chunk-encoder.js";
import { decodeChunk } from "../../src/stream/chunk-decoder.js";

const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

describe("encodeChunk", () => {
  it("encodes a response chunk in the §6.3 bare-string shorthand", () => {
    const bytes = encodeChunk({ type: "response", text: "hello" });
    expect(decode(bytes)).toEqual({ type: "response", data: "hello" });
  });

  it("encodes a response chunk with attachments in the rich object form", () => {
    const bytes = encodeChunk({
      type: "response",
      text: "see attached",
      attachments: [{ filename: "report.pdf", content: "QUJD" }],
    });
    expect(decode(bytes)).toEqual({
      type: "response",
      data: {
        text: "see attached",
        attachments: [{ filename: "report.pdf", content: "QUJD" }],
      },
    });
  });

  it("falls back to the bare-string form when attachments is empty", () => {
    const bytes = encodeChunk({ type: "response", text: "no files", attachments: [] });
    expect(decode(bytes)).toEqual({ type: "response", data: "no files" });
  });

  it("encodes a status chunk", () => {
    const bytes = encodeChunk({ type: "status", status: "ack" });
    expect(decode(bytes)).toEqual({ type: "status", data: "ack" });
  });

  it("encodes a query chunk with snake_case wire keys", () => {
    const bytes = encodeChunk({
      type: "query",
      id: "q1",
      replySubject: "_INBOX.agents.x",
      prompt: "are you sure?",
    });
    // `replySubject` (camelCase TS) → `reply_subject` (snake_case wire).
    expect(decode(bytes)).toEqual({
      type: "query",
      data: { id: "q1", reply_subject: "_INBOX.agents.x", prompt: "are you sure?" },
    });
  });

  it("encodes a query chunk with attachments", () => {
    const bytes = encodeChunk({
      type: "query",
      id: "q1",
      replySubject: "_INBOX.agents.x",
      prompt: "approve?",
      attachments: [{ filename: "diff.patch", content: "ZGlmZg==" }],
    });
    expect(decode(bytes)).toEqual({
      type: "query",
      data: {
        id: "q1",
        reply_subject: "_INBOX.agents.x",
        prompt: "approve?",
        attachments: [{ filename: "diff.patch", content: "ZGlmZg==" }],
      },
    });
  });

  it("round-trips through the decoder for all chunk types", () => {
    const responseBytes = encodeChunk({ type: "response", text: "hi" });
    const statusBytes = encodeChunk({ type: "status", status: "ack" });
    const queryBytes = encodeChunk({
      type: "query",
      id: "q1",
      replySubject: "_INBOX.x",
      prompt: "go?",
    });

    expect(decodeChunk(responseBytes)).toEqual({ type: "response", text: "hi" });
    expect(decodeChunk(statusBytes)).toEqual({ type: "status", status: "ack" });
    expect(decodeChunk(queryBytes)).toEqual({
      type: "query",
      id: "q1",
      replySubject: "_INBOX.x",
      prompt: "go?",
    });
  });
});

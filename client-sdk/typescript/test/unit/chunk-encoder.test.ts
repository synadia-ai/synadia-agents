import { describe, expect, it } from "vitest";
import { encodeChunk, splitResponseText } from "../../src/stream/chunk-encoder.js";
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

describe("splitResponseText", () => {
  it("returns an empty array for empty input", () => {
    expect(splitResponseText("", 1024)).toEqual([]);
  });

  it("returns the input unchanged when it fits within the budget", () => {
    expect(splitResponseText("hello", 1024)).toEqual(["hello"]);
  });

  it("splits a long ASCII string into multiple slices that all fit", () => {
    const text = "a".repeat(10_000);
    const slices = splitResponseText(text, 1024);
    expect(slices.length).toBeGreaterThan(1);
    expect(slices.join("")).toBe(text);
    // Each slice's UTF-8 size must fit the per-slice budget
    // (default reserveBytes=32, safetyDivisor=2 → ~496 bytes for 1024 max).
    for (const s of slices) {
      expect(new TextEncoder().encode(s).byteLength).toBeLessThanOrEqual(496);
    }
  });

  it("never splits inside a multi-byte UTF-8 sequence", () => {
    // 4-byte emoji repeated — every code point is 4 bytes UTF-8.
    const text = "🦀".repeat(500);
    const slices = splitResponseText(text, 256);
    expect(slices.length).toBeGreaterThan(1);
    expect(slices.join("")).toBe(text);
    // Every slice should re-decode without replacement chars.
    for (const s of slices) {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        new TextEncoder().encode(s),
      );
      expect(decoded).toBe(s);
    }
  });

  it("never splits inside a UTF-16 surrogate pair", () => {
    // Astral-plane character: surrogate pair on the JS string side.
    const text = "🚀".repeat(200); // 🚀
    const slices = splitResponseText(text, 256);
    expect(slices.length).toBeGreaterThan(1);
    for (const s of slices) {
      // No lone surrogate at slice boundaries.
      expect(s.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
      expect(s.charCodeAt(s.length - 1)).not.toBeLessThanOrEqual(0xdbff);
    }
    expect(slices.join("")).toBe(text);
  });

  it("honours an explicit safetyDivisor override", () => {
    const text = "a".repeat(10_000);
    const conservative = splitResponseText(text, 1024); // default divisor=2 → ~496B/slice
    const aggressive = splitResponseText(text, 1024, { safetyDivisor: 1 }); // ~992B/slice
    expect(aggressive.length).toBeLessThan(conservative.length);
    expect(conservative.join("")).toBe(text);
    expect(aggressive.join("")).toBe(text);
  });
});

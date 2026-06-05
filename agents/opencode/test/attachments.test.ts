import { describe, expect, test } from "bun:test";
import { ProtocolError, type RequestEnvelope } from "@synadia-ai/agents";
import { rejectUnsupportedAttachments } from "../src/attachments.js";

describe("attachments", () => {
  test("allows prompts without attachments", () => {
    expect(() => rejectUnsupportedAttachments({ prompt: "hello" })).not.toThrow();
  });

  test("rejects non-empty attachment envelopes with ProtocolError", () => {
    const envelope: RequestEnvelope = {
      prompt: "read this",
      attachments: [{ filename: "note.txt", content: new Uint8Array([1, 2, 3]) }],
    };
    expect(() => rejectUnsupportedAttachments(envelope)).toThrow(ProtocolError);
    expect(() => rejectUnsupportedAttachments(envelope)).toThrow("attachments are not supported");
  });
});

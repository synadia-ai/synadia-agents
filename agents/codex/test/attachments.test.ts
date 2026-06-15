import { describe, expect, test } from "bun:test";
import { rejectUnsupportedAttachments } from "../src/attachments.js";

describe("attachments", () => {
  test("allows plain text/no-attachment envelopes", () => {
    expect(() => rejectUnsupportedAttachments({ prompt: "hello" })).not.toThrow();
    expect(() => rejectUnsupportedAttachments({ prompt: "hello", attachments: [] })).not.toThrow();
  });

  test("rejects every non-empty attachment envelope", () => {
    expect(() => rejectUnsupportedAttachments({ prompt: "hello", attachments: [{ filename: "note.txt", content: new Uint8Array([1, 2, 3]) }] })).toThrow("attachments are not supported");
  });
});

import { describe, expect, test } from "bun:test";
import { FALLBACK_MEDIA_TYPE, attachmentToFilePart, mediaTypeForFilename } from "../src/attachments.js";

describe("mediaTypeForFilename", () => {
  test("maps common extensions case-insensitively", () => {
    expect(mediaTypeForFilename("note.txt")).toBe("text/plain");
    expect(mediaTypeForFilename("chart.PNG")).toBe("image/png");
    expect(mediaTypeForFilename("doc.pdf")).toBe("application/pdf");
    expect(mediaTypeForFilename("data.json")).toBe("application/json");
  });

  test("falls back to octet-stream for unknown, missing, or trailing-dot extensions", () => {
    expect(mediaTypeForFilename("archive.xyzzy")).toBe(FALLBACK_MEDIA_TYPE);
    expect(mediaTypeForFilename("no-extension")).toBe(FALLBACK_MEDIA_TYPE);
    expect(mediaTypeForFilename("trailing.")).toBe(FALLBACK_MEDIA_TYPE);
  });
});

describe("attachmentToFilePart", () => {
  test("builds an inline data: URL file part with mapped media type", () => {
    const part = attachmentToFilePart({
      filename: "note.txt",
      content: new TextEncoder().encode("ABC"),
    });
    expect(part).toEqual({
      type: "file",
      data: "data:text/plain;base64,QUJD",
      mediaType: "text/plain",
      filename: "note.txt",
    });
  });
});

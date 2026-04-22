import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeAttachment, normalizeAttachments } from "../../src/prompt/attachments.js";

describe("normalizeAttachment", () => {
  let tmp: string;
  let samplePath: string;

  beforeAll(async () => {
    tmp = await mkdtemp(joinPath(tmpdir(), "agents-sdk-test-"));
    samplePath = joinPath(tmp, "sample.txt");
    await writeFile(samplePath, "hello");
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads from a filesystem path string", async () => {
    const a = await normalizeAttachment(samplePath);
    expect(a.filename).toBe("sample.txt");
    expect(new TextDecoder().decode(a.content)).toBe("hello");
  });

  it("reads from a file: URL", async () => {
    const a = await normalizeAttachment(pathToFileURL(samplePath));
    expect(a.filename).toBe("sample.txt");
  });

  it("uses an object input directly", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const a = await normalizeAttachment({ filename: "x.bin", content: bytes });
    expect(a.filename).toBe("x.bin");
    expect(a.content).toBe(bytes); // same reference — no copy
  });

  it("rejects non-file URLs", async () => {
    await expect(normalizeAttachment(new URL("https://example.com"))).rejects.toThrow(/file:/);
  });

  it("rejects object input missing filename", async () => {
    // @ts-expect-error — testing runtime rejection
    await expect(normalizeAttachment({ content: new Uint8Array(0) })).rejects.toThrow(/filename/);
  });

  it("rejects object input with non-Uint8Array content", async () => {
    // @ts-expect-error — testing runtime rejection
    await expect(normalizeAttachment({ filename: "x", content: "string" })).rejects.toThrow(
      /Uint8Array/,
    );
  });

  it("normalizeAttachments handles a batch concurrently", async () => {
    const results = await normalizeAttachments([
      samplePath,
      { filename: "inline.bin", content: new Uint8Array([9]) },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]!.filename).toBe("sample.txt");
    expect(results[1]!.filename).toBe("inline.bin");
  });
});

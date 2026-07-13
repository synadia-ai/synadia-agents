// Normalize user-supplied attachment inputs into the uniform
// `{ filename, content: Uint8Array }` shape the envelope encoder expects.
//
// Supported input forms:
//   - `string`  — filesystem path (read via `node:fs/promises`).
//   - `URL`     — `file:` URL (file: protocol required).
//   - object    — `{ filename: string, content: Uint8Array }`.
//
// File I/O lives here (shell layer); the envelope stays pure.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestAttachment } from "./envelope.js";

export type AttachmentInput =
  string | URL | { readonly filename: string; readonly content: Uint8Array };

/** Resolve an attachment input to the wire-ready `{ filename, content: Uint8Array }`. */
export async function normalizeAttachment(input: AttachmentInput): Promise<RequestAttachment> {
  if (typeof input === "string") {
    return readFromPath(input);
  }
  if (input instanceof URL) {
    if (input.protocol !== "file:") {
      throw new TypeError(
        `attachment URL must use file: protocol (got "${input.protocol}" for ${input.href})`,
      );
    }
    return readFromPath(fileURLToPath(input));
  }
  if (typeof input === "object" && input !== null) {
    const { filename, content } = input;
    if (typeof filename !== "string" || filename.length === 0) {
      throw new TypeError("attachment object must have a non-empty `filename`");
    }
    if (!(content instanceof Uint8Array)) {
      throw new TypeError("attachment object `content` must be a Uint8Array");
    }
    return { filename, content };
  }
  throw new TypeError(`unsupported attachment input: ${typeof input}`);
}

/** Normalize an array of attachment inputs concurrently. */
export async function normalizeAttachments(
  inputs: ReadonlyArray<AttachmentInput>,
): Promise<ReadonlyArray<RequestAttachment>> {
  return Promise.all(inputs.map(normalizeAttachment));
}

async function readFromPath(path: string): Promise<RequestAttachment> {
  const buf = await readFile(path);
  // Ensure we return a plain Uint8Array view (not a Buffer) — downstream
  // stays runtime-agnostic.
  const content = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return { filename: basename(path), content };
}

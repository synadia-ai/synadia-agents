// Attachment staging for spawned PI sessions.
//
// Each attachment decodes to disk under
// `~/.pi-headless/attachments/<session_id>/<uuid>/<filename>` and the
// absolute paths are prepended to the prompt text. This mirrors the
// pattern used by `agents/pi/`.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ParsedAttachment } from "./envelope.js";

const ROOT = join(homedir(), ".pi-headless", "attachments");

export interface StagedAttachmentGroup {
  /** Absolute directory created for this prompt; safe to delete when done. */
  readonly dir: string;
  /** Absolute file paths in order, matching the attachment array. */
  readonly paths: ReadonlyArray<string>;
}

export async function stageAttachments(
  sessionId: string,
  attachments: ReadonlyArray<ParsedAttachment>,
): Promise<StagedAttachmentGroup> {
  const dir = pathResolve(join(ROOT, sessionId, randomUUID()));
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const att of attachments) {
    const safeName = sanitizeFilename(att.filename);
    const filePath = join(dir, safeName);
    const bytes = decodeBase64Strict(att.base64);
    await writeFile(filePath, bytes);
    paths.push(filePath);
  }
  return { dir, paths };
}

export async function cleanupStaged(group: StagedAttachmentGroup): Promise<void> {
  try {
    await rm(group.dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** Prepend attachment paths as a simple header block so PI can reference them. */
export function decorateWithAttachments(prompt: string, paths: ReadonlyArray<string>): string {
  if (paths.length === 0) return prompt;
  const header = [
    "[Attachments available at the following absolute paths]",
    ...paths.map((p) => `- ${p}`),
    "",
  ].join("\n");
  return `${header}\n${prompt}`;
}

// Reject URL-safe base64 / whitespace per §5.2.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64Strict(input: string): Uint8Array {
  if (!BASE64_RE.test(input)) {
    throw new Error("attachment content is not valid RFC 4648 §4 base64");
  }
  return Uint8Array.from(Buffer.from(input, "base64"));
}

// No path traversal, no separators.
function sanitizeFilename(name: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "_");
  // Collapse dot-dot after sanitization just in case.
  return base.replace(/^\.+/, "_").slice(0, 255) || "file";
}

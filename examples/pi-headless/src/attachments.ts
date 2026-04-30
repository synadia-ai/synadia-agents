// Attachment staging for spawned PI sessions.
//
// Each attachment lands on disk under
// `~/.pi-headless/attachments/<session_id>/<uuid>/<filename>` and the
// absolute paths are prepended to the prompt text. Mirrors the pattern
// used by `agents/pi/`.
//
// The SDK's `decodeEnvelope` already vets filenames (rejects `..`,
// path separators, NUL) and decodes base64 to bytes — see
// `RequestAttachment` in `@synadia-ai/agents`. This module only owns
// the on-disk side: a final filename sanitiser (replaces residual
// non-portable characters with `_`) and the per-prompt staging dir.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { RequestAttachment } from "@synadia-ai/agents";

const ROOT = join(homedir(), ".pi-headless", "attachments");

export interface StagedAttachmentGroup {
  /** Absolute directory created for this prompt; safe to delete when done. */
  readonly dir: string;
  /** Absolute file paths in order, matching the attachment array. */
  readonly paths: ReadonlyArray<string>;
}

export async function stageAttachments(
  sessionId: string,
  attachments: ReadonlyArray<RequestAttachment>,
): Promise<StagedAttachmentGroup> {
  const dir = pathResolve(join(ROOT, sessionId, randomUUID()));
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const att of attachments) {
    const safeName = sanitizeFilename(att.filename);
    const filePath = join(dir, safeName);
    await writeFile(filePath, att.content);
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

// `decodeEnvelope` already rejects path separators and `..` components, but
// keep a final guard against residual characters (whitespace, shell-special
// glyphs) so the staged path is well-behaved when interpolated into PI's
// prompt. Cap at 255 to stay under common filesystem limits.
function sanitizeFilename(name: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "_");
  return base.replace(/^\.+/, "_").slice(0, 255) || "file";
}

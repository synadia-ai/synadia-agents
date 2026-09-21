// Save received attachments to disk: the receiving counterpart of
// `normalizeAttachments` (`./attachments.ts`).
//
// A reply's attachments (§6.3) and a mid-stream query's (§7.1) arrive as
// `{ filename, content: <base64> }` — `DecodedAttachment` keeps the content
// as the wire string. This helper decodes each one and writes it into a
// directory, so a caller can hand its model a list of paths instead of
// base64. The name comes from another agent and is untrusted: only its last
// path component survives, sanitized, and a file is only ever created —
// never overwritten, never reached through a link.
//
// The Python SDK's `save_attachments` (`synadia_ai.agents.attachments`)
// behaves the same; `test-fixtures/attachments/` holds the shared cases.
//
// File I/O lives here (shell layer); the envelope stays pure.

import { type FileHandle, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Default for {@link SaveAttachmentsOptions.maxTotalBytes}: 64 MiB of decoded bytes per call. */
export const DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** One entry per input attachment, in input order. */
export interface SavedAttachment {
  /** The name exactly as the sender gave it (the file on disk may differ; see `path`). */
  readonly filename: string;
  /** Decoded size in bytes; `0` when the content was invalid. */
  readonly sizeBytes: number;
  /** Absolute path of the written file; `null` when the attachment was not saved. */
  readonly path: string | null;
  /** Why the attachment was not saved; present iff `path` is `null`. */
  readonly skipped?: "over_limit" | "invalid_content";
}

export interface SaveAttachmentsOptions {
  /**
   * Upper bound on the decoded bytes this call writes, summed over the
   * attachments it saves. An attachment that would push the total past it
   * is skipped (`"over_limit"`); a later, smaller one may still fit.
   * Default {@link DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES}; `Infinity`
   * disables the limit.
   */
  readonly maxTotalBytes?: number;
}

/** A name longer than this many UTF-8 bytes is shortened. */
const MAX_NAME_BYTES = 200;
/** An extension (dot included) up to this many characters survives shortening. */
const MAX_EXTENSION_CHARS = 16;
/** `<stem> (2)<ext>` … `<stem> (1000)<ext>`, then give up. */
const MAX_NAME_ATTEMPTS = 1000;

const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// Stripped from both ends of a name: dots, and the union of what
// JavaScript's `\s` and Python's `str.isspace()` call whitespace (control
// characters are removed before this runs), so both SDKs trim alike.
// Literals, not a computed `Set`: a bundle that never calls
// `saveAttachments` drops this module whole.
const EDGE_CHARS =
  " .\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
  "\u2028\u2029\u202f\u205f\u3000\ufeff";
const REPLACEMENT_CHARACTER = "\ufffd";
// Replaced by `_`: the characters Windows forbids in a name, besides the
// separators and control characters handled already. On every OS, so a
// name comes out the same wherever it is saved.
const WINDOWS_FORBIDDEN = '<>:"|?*';
// A Windows device name (Microsoft's list: CON, PRN, AUX, NUL, COM1 to COM9,
// LPT1 to LPT9, COM and LPT with a superscript ¹ ² ³; and the console's
// CONIN$ and CONOUT$), any case, alone or before a dot: `NUL.tar.gz` is the
// device too. Spaces before the dot are ignored, on the side of caution, as
// Python's `os.path.isreserved` does.
const WINDOWS_DEVICE_NAME_RE =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9\u00b9\u00b2\u00b3]) *(?:\.|$)/i;
// On POSIX: the mode of a saved file, and of a directory this module creates.
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/**
 * Decode received attachments and write each into `dir` (created if
 * missing), in order. Returns one {@link SavedAttachment} per input, in the
 * same order.
 *
 * - **Content** must be strict RFC 4648 §4 base64 (§5.2: standard alphabet,
 *   padded, no whitespace). Anything else is not written:
 *   `skipped: "invalid_content"`. Bad content never throws.
 * - **Name**: the part after the last `/` or `\`, control characters and
 *   the characters that change text direction (U+200E, U+200F,
 *   U+202A–U+202E, U+2066–U+2069) removed, `< > : " | ? *` replaced by `_`,
 *   leading and trailing dots and whitespace stripped, `attachment-<n>` (1-based position) when nothing
 *   is left, shortened to 200 UTF-8 bytes keeping an extension of up to 16
 *   characters, and a Windows device name (`CON`, `nul.txt`, `COM1.log`)
 *   prefixed with `_`. The same on every OS.
 * - **Never overwrites, never follows a link**: each file is created
 *   exclusively; on a clash (an earlier attachment, a file or a symlink
 *   already there) the next free `<stem> (2)<ext>`, `(3)`, … is used.
 * - **Private**: on POSIX a file is created with mode 0600 and a directory
 *   this call creates, `dir` or a missing parent, with 0700; a directory
 *   that already exists keeps its mode.
 * - **Limit**: see {@link SaveAttachmentsOptions.maxTotalBytes}.
 *
 * Real I/O errors (permissions, disk full) reject the promise; a file this
 * call created and could not finish writing is removed first.
 */
export async function saveAttachments(
  attachments: ReadonlyArray<{ readonly filename: string; readonly content: string }>,
  dir: string,
  options: SaveAttachmentsOptions = {},
): Promise<SavedAttachment[]> {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES;
  if (Number.isNaN(maxTotalBytes) || maxTotalBytes < 0) {
    throw new RangeError(
      `saveAttachments: maxTotalBytes must be a non-negative number or Infinity (got ${maxTotalBytes})`,
    );
  }
  const root = resolve(dir);
  // Every directory a recursive `mkdir` creates gets the mode, parents included.
  await mkdir(root, { recursive: true, mode: DIRECTORY_MODE });

  const saved: SavedAttachment[] = [];
  let total = 0;
  for (const [index, attachment] of attachments.entries()) {
    // Typed as strings, but a JavaScript caller may hand anything: a
    // non-string name falls back like an empty one, non-string content is
    // invalid content.
    const filename: unknown = attachment.filename;
    const content: unknown = attachment.content;
    const senderName = typeof filename === "string" ? filename : "";
    const size = typeof content === "string" ? strictBase64Size(content) : null;
    if (typeof content !== "string" || size === null) {
      saved.push({ filename: senderName, sizeBytes: 0, path: null, skipped: "invalid_content" });
      continue;
    }
    if (total + size > maxTotalBytes) {
      saved.push({ filename: senderName, sizeBytes: size, path: null, skipped: "over_limit" });
      continue;
    }
    const bytes = Buffer.from(content, "base64");
    const path = await createExclusive(root, safeAttachmentName(senderName, index + 1), bytes);
    total += size;
    saved.push({ filename: senderName, sizeBytes: size, path });
  }
  return saved;
}

/**
 * Decoded size of strict RFC 4648 §4 base64, or `null` when `content` is
 * not strict base64. Computed from the text, so an attachment over the
 * limit is never decoded.
 */
function strictBase64Size(content: string): number | null {
  if (content.length % 4 !== 0 || !STRICT_BASE64_RE.test(content)) return null;
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return (content.length / 4) * 3 - padding;
}

/**
 * The name an attachment is saved under, before any `(n)` suffix: see
 * {@link saveAttachments}. `position` is the attachment's 1-based place in
 * the input. Exported for the shared fixture tests; not part of the
 * package's public surface.
 *
 * @internal
 */
export function safeAttachmentName(name: string, position: number): string {
  const lastSeparator = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  let out = "";
  // Iterates code points; a lone surrogate comes out on its own and is
  // replaced, so the name always encodes to UTF-8 (as in Python).
  for (const ch of name.slice(lastSeparator + 1)) {
    const cp = ch.codePointAt(0)!;
    // C0, DEL and C1: U+009B, for one, starts a terminal escape sequence.
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) continue;
    // Direction marks, embeddings, overrides and isolates: they let a shown
    // name be spoofed (`evil<U+202E>txt.exe` shows as `evilexe.txt`).
    if (cp === 0x200e || cp === 0x200f) continue;
    if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) continue;
    if (cp >= 0xd800 && cp <= 0xdfff) out += REPLACEMENT_CHARACTER;
    else out += WINDOWS_FORBIDDEN.includes(ch) ? "_" : ch;
  }
  out = trimEdges(out);
  if (out === "") return `attachment-${position}`;
  out = shortenName(out);
  // Checked after shortening, since a cut can leave one (`CON` + spaces + …).
  return WINDOWS_DEVICE_NAME_RE.test(out) ? shortenName(`_${out}`) : out;
}

function shortenName(name: string): string {
  if (utf8Length(name) <= MAX_NAME_BYTES) return name;
  let [stem, ext] = splitExtension(name);
  if ([...ext].length > MAX_EXTENSION_CHARS) {
    stem = name;
    ext = "";
  }
  const budget = MAX_NAME_BYTES - utf8Length(ext);
  let kept = "";
  let used = 0;
  for (const ch of stem) {
    const bytes = utf8Length(ch);
    if (used + bytes > budget) break;
    kept += ch;
    used += bytes;
  }
  // The cut may land after a dot or a space; the name must not end on one.
  return trimEdges(kept) + ext;
}

/** `["archive.tar", ".gz"]`; no extension when there is no dot past the first character. */
function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

// Linear on purpose: the name is untrusted and may be long, and a
// `[...]+$` regex backtracks quadratically on a run of dots.
function trimEdges(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && EDGE_CHARS.includes(s[start]!)) start++;
  while (end > start && EDGE_CHARS.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

function utf8Length(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Create `name` in `root` with mode 0600 and `O_CREAT | O_EXCL` — which
 * fails on any existing entry, a symlink included, without following it —
 * trying `<stem> (n)<ext>` on a clash. Returns the absolute path written.
 */
async function createExclusive(root: string, name: string, bytes: Uint8Array): Promise<string> {
  const [stem, ext] = splitExtension(name);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const path = join(root, attempt === 1 ? name : `${stem} (${attempt})${ext}`);
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", FILE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      await handle.writeFile(bytes);
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw err;
    }
    return path;
  }
  throw new Error(
    `saveAttachments: no free name for "${name}" in ${root} after ${MAX_NAME_ATTEMPTS} attempts`,
  );
}

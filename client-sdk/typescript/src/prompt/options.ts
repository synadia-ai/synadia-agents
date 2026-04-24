// Caller-facing `prompt()` options. Kept in its own module so the shape is
// stable and callers can import it without pulling in the shell layer.

import type { AttachmentInput } from "./attachments.js";

export interface PromptOptions {
  /** Zero or more attachments — file path, `file:` URL, or bytes object. */
  readonly attachments?: ReadonlyArray<AttachmentInput>;
  /** Per-stream inactivity timeout (§6.6). Default: the `Agents`-level configured value (60_000ms). */
  readonly inactivityTimeoutMs?: number;
  /** `AbortSignal` that aborts the stream when triggered (added in M5). */
  readonly signal?: AbortSignal;
}

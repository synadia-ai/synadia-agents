// Caller-facing `prompt()` options. Kept in its own module so the shape is
// stable and callers can import it without pulling in the shell layer.

import type { AttachmentInput } from "./attachments.js";

export interface PromptOptions {
  /** Zero or more attachments — file path, `file:` URL, or bytes object. */
  readonly attachments?: ReadonlyArray<AttachmentInput>;
  /** Per-stream inactivity timeout (§6.6). Default: the `Agents`-level configured value (60_000ms). */
  readonly inactivityTimeoutMs?: number;
  /**
   * Absolute ceiling for the entire prompt response, in milliseconds. Passed
   * straight through to `nc.requestMany`'s `maxWait`. The stream throws
   * `StreamMaxWaitExceededError` if the terminator hasn't arrived by then,
   * even if chunks are still trickling under the inactivity gap.
   * Default: {@link DEFAULT_PROMPT_MAX_WAIT_MS} (10 minutes).
   */
  readonly maxWaitMs?: number;
  /** `AbortSignal` that aborts the stream when triggered (added in M5). */
  readonly signal?: AbortSignal;
}

/** Default absolute ceiling for a single `prompt()` response — 10 minutes. */
export const DEFAULT_PROMPT_MAX_WAIT_MS = 600_000;

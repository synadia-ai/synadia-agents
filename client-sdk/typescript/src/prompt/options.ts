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
  /**
   * Subject to publish to instead of the discovered prompt endpoint
   * subject. For a caller behind a service import that remaps the
   * subject (`to:` / `local_subject`, or an export that inserts the
   * caller's account token): discovery reports the exporter's subject,
   * which a caller behind an import cannot publish to.
   */
  readonly subject?: string;
  /**
   * Subject to sign into the `Agent-Sender` header (`sub`). Defaults to
   * `subject`. Set it only when the caller's **own** account renamed the
   * import: then sign the exporter's subject — the `subject` the import
   * names, which is also what discovery reported. Behind an export that
   * inserts the account token, leave it unset (the receiver strips the
   * token).
   */
  readonly sub?: string;
  /**
   * The ID of the model tool call this prompt serves, used to label the
   * trace edge when tracing is enabled.
   */
  readonly toolCallId?: string;
}

/** `Agent.status()` options — the same remap overrides as {@link PromptOptions}. */
export interface StatusOptions {
  /** Subject to publish to instead of the discovered status endpoint subject. */
  readonly subject?: string;
  /** Subject to sign (`sub`). Defaults to `subject`. */
  readonly sub?: string;
  /** Request timeout in milliseconds. Default {@link DEFAULT_STATUS_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Default `Agent.status()` request timeout — 2 seconds. */
export const DEFAULT_STATUS_TIMEOUT_MS = 2_000;

/** Default absolute ceiling for a single `prompt()` response — 10 minutes. */
export const DEFAULT_PROMPT_MAX_WAIT_MS = 600_000;

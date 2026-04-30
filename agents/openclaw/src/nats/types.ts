// ─────────────────────────────────────────────────────────────────────────────
// Connection
// ─────────────────────────────────────────────────────────────────────────────

export interface ConnectionConfig {
  url?: string;
  credentials?: string;
  name?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent registration config (spec §3.1–§3.2)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentConfig {
  /** 4th subject token + instance identity. */
  name: string;
  /** 3rd subject token; `metadata.owner`. Defaults to `"default"` when unset. */
  owner: string;
  /** `metadata.session`; session-less harnesses use `"default"`. */
  session?: string;
  description: string;
  version?: string;
  /** Extra keys merged into service metadata (must preserve per §3.2). */
  metadata?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachment shape used by `attachments.ts` for OpenClaw's media-allowlist
// staging step. Distinct from the SDK's `RequestAttachment` because the
// stager has already vetted the filename and decoded the bytes.
// ─────────────────────────────────────────────────────────────────────────────

export interface DecodedAttachment {
  /** Sanitized basename, safe to join with a staging directory. */
  filename: string;
  bytes: Uint8Array;
}

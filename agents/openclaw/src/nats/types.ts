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
// Request envelope (spec §5)
// ─────────────────────────────────────────────────────────────────────────────

export interface DecodedAttachment {
  /** Sanitized basename, safe to join with a staging directory. */
  filename: string;
  bytes: Uint8Array;
}

export type ParsedEnvelope =
  | { ok: true; prompt: string; attachments: DecodedAttachment[] }
  | { ok: false; code: 400; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat payload (spec §8.3)
// ─────────────────────────────────────────────────────────────────────────────

export interface HeartbeatPayload {
  agent: string;
  owner: string;
  session: string;
  instance_id: string;
  ts: string;
  interval_s: number;
}

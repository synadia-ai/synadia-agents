// Wire protocol for the NATS Agent Protocol v0.3 — the subject conventions,
// the request envelope shape, the typed response chunks, the heartbeat
// payload, and the validation that keeps strict inputs strict.
//
// Pure module (no NATS, no fs). Staging to disk and timers live in
// `../attachments.ts` and `../gateway.ts`.

import { basename } from "node:path";
import { headers as createHeaders } from "@nats-io/nats-core";
import type { MsgHdrs } from "@nats-io/nats-core";
import type { DecodedAttachment, HeartbeatPayload, ParsedEnvelope } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Spec constants (mirror `@synadia-ai/agents` v0.3)
// ─────────────────────────────────────────────────────────────────────────────

/** Spec §3.1: the service name is the bare token `agents`. Subject-safe as-is. */
export const SERVICE_NAME = "agents";
/** Spec §3.3: queue group that the `prompt` endpoint MUST register with. */
export const PROMPT_QUEUE_GROUP = "agents";
/** v0.3 §-TBD: the `status` endpoint shares the prompt's queue group. */
export const STATUS_QUEUE_GROUP = "agents";
export const SERVICE_VERSION = "0.5.0";
export const PROTOCOL_VERSION = "0.3";

/** Spec §2, Appendix C: canonical agent id is `openclaw`, subject abbreviation
 *  is `oc`. The protocol doesn't cross-match full-form and abbreviated tokens
 *  under a wildcard, so commit to one per deployment. */
export const AGENT_ID = "openclaw";
export const SUBJECT_AGENT_TOKEN = "oc";

/** Session-less harnesses MAY omit `metadata.session` or set it to "default"
 *  (spec Appendix C). We set it so callers always see a value in $SRV.INFO. */
export const DEFAULT_SESSION = "default";

export const MAX_PAYLOAD_STR = "1MB";
export const MAX_PAYLOAD_BYTES = 1024 * 1024; // base-1024, NATS convention
export const ATTACHMENTS_OK = true;

/** Spec §8.2 recommended default cadence. */
export const HEARTBEAT_INTERVAL_S = 30;

/** Time between keep-alive `ack` chunks emitted while a prompt is in flight.
 *  Well under the spec's recommended 60s inactivity timeout (§6.6) so a busy
 *  OpenClaw pipeline doesn't trip the caller's stall detector. */
export const ACK_KEEPALIVE_MS = 20_000;

// ─────────────────────────────────────────────────────────────────────────────
// Subject builders
// ─────────────────────────────────────────────────────────────────────────────

// Subject builders (§2 v0.3 — verb-first: `agents.{verb}.{a}.{o}.{n}`).
export function promptSubject(owner: string, name: string): string {
  return `agents.prompt.${SUBJECT_AGENT_TOKEN}.${owner}.${name}`;
}

export function heartbeatSubject(owner: string, name: string): string {
  return `agents.hb.${SUBJECT_AGENT_TOKEN}.${owner}.${name}`;
}

export function statusSubject(owner: string, name: string): string {
  return `agents.status.${SUBJECT_AGENT_TOKEN}.${owner}.${name}`;
}

/** OpenClaw-specific extension — agent-initiated messages (pub/sub, not part
 *  of the spec). Sits one level deeper than the verb-first subjects so it
 *  doesn't collide with reserved verbs. */
export function outboundSubject(owner: string, name: string): string {
  return `agents.${SUBJECT_AGENT_TOKEN}.${owner}.${name}.outbound`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request envelope (spec §5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a request payload per spec §5.1 / §5.3.
 *
 * 1. Zero-byte → 400.
 * 2. Skip leading UTF-8 whitespace (0x09 / 0x0A / 0x0D / 0x20).
 * 3. If the next byte is `{`: parse JSON; require a non-empty string `prompt`.
 *    Each attachment is strictly decoded here so the gateway only ever deals
 *    with vetted in-memory bytes.
 * 4. Otherwise: promote the raw payload to `{prompt: <payload>}`.
 *
 * Unknown envelope fields (e.g. `from` from the legacy wire) are tolerated and
 * silently ignored per §5.6.
 */
export function parseEnvelope(data: Uint8Array): ParsedEnvelope {
  if (data.byteLength === 0) {
    return { ok: false, code: 400, error: "empty payload" };
  }

  let i = 0;
  while (
    i < data.byteLength &&
    (data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d || data[i] === 0x20)
  ) {
    i++;
  }
  if (i === data.byteLength) {
    return { ok: false, code: 400, error: "empty payload after whitespace" };
  }

  if (data[i] === 0x7b /* '{' */) {
    const text = new TextDecoder().decode(data);
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return { ok: false, code: 400, error: "invalid JSON envelope" };
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      return { ok: false, code: 400, error: "envelope must be a JSON object" };
    }
    const rec = obj as Record<string, unknown>;
    if (typeof rec.prompt !== "string" || rec.prompt.length === 0) {
      return { ok: false, code: 400, error: "envelope missing non-empty string 'prompt'" };
    }

    const attachments: DecodedAttachment[] = [];
    if (rec.attachments !== undefined) {
      if (!Array.isArray(rec.attachments)) {
        return { ok: false, code: 400, error: "attachments must be an array" };
      }
      for (let idx = 0; idx < rec.attachments.length; idx++) {
        const a = rec.attachments[idx];
        if (typeof a !== "object" || a === null || Array.isArray(a)) {
          return { ok: false, code: 400, error: `attachment[${idx}] must be an object` };
        }
        const ar = a as Record<string, unknown>;
        if (typeof ar.filename !== "string") {
          return {
            ok: false,
            code: 400,
            error: `attachment[${idx}] missing string 'filename'`,
          };
        }
        if (typeof ar.content !== "string") {
          return {
            ok: false,
            code: 400,
            error: `attachment[${idx}] missing string 'content'`,
          };
        }
        const safeName = sanitizeFilename(ar.filename);
        if (safeName === null) {
          return {
            ok: false,
            code: 400,
            error: `attachment[${idx}] has unsafe filename`,
          };
        }
        const bytes = decodeStrictBase64(ar.content);
        if (bytes === null) {
          return {
            ok: false,
            code: 400,
            error: `attachment[${idx}] has invalid base64 content`,
          };
        }
        attachments.push({ filename: safeName, bytes });
      }
    }
    return { ok: true, prompt: rec.prompt, attachments };
  }

  // Plain-text shorthand (§5.1).
  const text = new TextDecoder().decode(data);
  return { ok: true, prompt: text, attachments: [] };
}

/**
 * Strict RFC 4648 §4 base64 per spec §5.2: standard alphabet, padded, no
 * whitespace, no URL-safe. `Buffer.from(_, "base64")` is tolerant of all
 * three relaxations, so validate shape first.
 */
const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeStrictBase64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0) return null;
  if (!STRICT_BASE64.test(s)) return null;
  return new Uint8Array(Buffer.from(s, "base64"));
}

/**
 * Filename validator. Strict: rejects anything that isn't a plain basename. We
 * deliberately do NOT auto-normalize (`basename("../x")` → `x`) because
 * silently rewriting the name would hide the caller's intent and let a buggy
 * SDK ship structured paths we've quietly flattened.
 */
export function sanitizeFilename(raw: string): string | null {
  if (raw.length === 0 || raw.length > 255) return null;
  if (raw.includes("\0")) return null;
  if (raw.includes("/") || raw.includes("\\")) return null;
  if (raw === "." || raw === "..") return null;
  if (basename(raw) !== raw) return null;
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk helpers (spec §6)
// ─────────────────────────────────────────────────────────────────────────────

/** Shape a `{type:"response", data: <text>}` chunk body. */
export function wrapResponseChunk(text: string): string {
  return JSON.stringify({ type: "response", data: text });
}

/** Shape a `{type:"status", data: <status>}` chunk body. */
export function wrapStatusChunk(status: string): string {
  return JSON.stringify({ type: "status", data: status });
}

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat (spec §8)
// ─────────────────────────────────────────────────────────────────────────────

export function buildHeartbeatPayload(args: {
  owner: string;
  session: string;
  instanceId: string;
  intervalS: number;
}): HeartbeatPayload {
  return {
    agent: AGENT_ID,
    owner: args.owner,
    session: args.session,
    instance_id: args.instanceId,
    ts: new Date().toISOString(),
    interval_s: args.intervalS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NATS header utilities (unchanged from prior version — used by callers that
// want to round-trip headers through this module)
// ─────────────────────────────────────────────────────────────────────────────

export function toNatsHeaders(entries: Record<string, string>): MsgHdrs {
  const hdrs = createHeaders();
  for (const [key, value] of Object.entries(entries)) {
    hdrs.set(key, value);
  }
  return hdrs;
}

export function fromNatsHeaders(hdrs: MsgHdrs | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!hdrs) return result;
  for (const key of hdrs.keys()) {
    const values = hdrs.values(key);
    if (values && values.length > 0) {
      result[key] = values[0];
    }
  }
  return result;
}

// Heartbeat payload per spec §8.3.
//
// Wire shape (v0.3):
//   {
//     "agent": "claude-code",
//     "owner": "aconnolly",
//     "session": "alice",                          // optional, §5.6
//     "instance_id": "VMKS6MHK71PCPWGY38A7N5",
//     "ts": "2026-04-21T14:23:01Z",
//     "interval_s": 30
//   }
//
// Published on `agents.hb.{agent}.{owner}.{name}` (§8.1 v0.3) — the
// instance name is NOT in the payload; receivers extract it from the 5th
// subject token. The optional `session` field carries the §5.6 envelope-
// level conversation label for harnesses that multiplex over a single
// subject (e.g. Hermes). Callers MUST tolerate additional unknown fields
// (§8.3, §12).

import type { AgentSubject } from "../subjects.js";

export interface HeartbeatPayload {
  readonly agent: string;
  readonly owner: string;
  readonly session?: string;
  readonly instanceId: string;
  readonly ts: string;
  readonly intervalS: number;
  /** Any additional fields on the heartbeat payload, preserved verbatim. */
  readonly extras: Readonly<Record<string, unknown>>;
}

const KNOWN_FIELDS = new Set(["agent", "owner", "session", "instance_id", "ts", "interval_s"]);

/**
 * Decode a heartbeat payload from an already-parsed JSON value.
 *
 * Returns `null` for malformed input — callers treat a decode failure as
 * "ignore this heartbeat", not as a fatal error, per §6.6 forward-compat.
 */
export function decodeHeartbeatPayload(input: unknown): HeartbeatPayload | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;

  if (
    typeof o["agent"] !== "string" ||
    typeof o["owner"] !== "string" ||
    typeof o["instance_id"] !== "string" ||
    typeof o["ts"] !== "string" ||
    typeof o["interval_s"] !== "number" ||
    !Number.isFinite(o["interval_s"]) ||
    o["interval_s"] <= 0
  ) {
    return null;
  }

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!KNOWN_FIELDS.has(k)) extras[k] = v;
  }

  const session =
    typeof o["session"] === "string" && o["session"] !== "" ? o["session"] : undefined;

  return Object.freeze({
    agent: o["agent"],
    owner: o["owner"],
    instanceId: o["instance_id"],
    ts: o["ts"],
    intervalS: o["interval_s"],
    extras: Object.freeze(extras),
    ...(session !== undefined ? { session } : {}),
  });
}

export interface BuildHeartbeatPayloadOptions {
  /** §5.6 envelope-level session label, when the harness multiplexes. */
  readonly session?: string;
  /** Extra forward-compat fields merged into the wire payload. */
  readonly extras?: Readonly<Record<string, unknown>>;
}

/**
 * Construct a §8.3 heartbeat payload for `subject`.
 *
 * Pure helper shared between the heartbeat publisher and the v0.3 status
 * request/response endpoint — both emit the same payload shape, and any
 * richer agent metadata added in future PRs lands here in one place.
 */
export function buildHeartbeatPayload(
  subject: AgentSubject,
  intervalS: number,
  instanceId: string,
  options: BuildHeartbeatPayloadOptions = {},
): HeartbeatPayload {
  return Object.freeze({
    agent: subject.agent,
    owner: subject.owner,
    instanceId,
    ts: new Date().toISOString(),
    intervalS,
    extras: Object.freeze({ ...(options.extras ?? {}) }),
    ...(options.session !== undefined ? { session: options.session } : {}),
  });
}

/**
 * Encode a {@link HeartbeatPayload} to wire-shape JSON bytes (snake_case
 * keys per §8.3). `extras` are splatted alongside the known fields so a
 * `decode → build` round-trip preserves forward-compat fields.
 */
export function encodeHeartbeatPayload(payload: HeartbeatPayload): Uint8Array {
  const wire: Record<string, unknown> = {
    agent: payload.agent,
    owner: payload.owner,
    instance_id: payload.instanceId,
    ts: payload.ts,
    interval_s: payload.intervalS,
    ...payload.extras,
  };
  if (payload.session !== undefined) wire["session"] = payload.session;
  return new TextEncoder().encode(JSON.stringify(wire));
}

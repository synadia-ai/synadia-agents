// Heartbeat payload per spec §8.3 — caller-side type + decoder.
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
//
// The encoder side (`buildHeartbeatPayload`, `encodeHeartbeatPayload`)
// lives in the host SDK (`@synadia-ai/agent-service`) — both packages
// share the {@link HeartbeatPayload} type from here.

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

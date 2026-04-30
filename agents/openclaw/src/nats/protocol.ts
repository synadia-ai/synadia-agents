// OpenClaw-specific protocol pieces. Everything that's protocol-shared
// (subject builders, envelope decoder, chunk encoder, heartbeat payload,
// service-name constants, max_payload formatting) now comes from
// `@synadia-ai/agents` directly — see `gateway.ts` for the imports. This
// file holds only the bits that are genuinely OpenClaw-flavoured:
// agent identity, custom outbound subject, NATS header sugar.

import { headers as createHeaders } from "@nats-io/nats-core";
import type { MsgHdrs } from "@nats-io/nats-core";

// ─────────────────────────────────────────────────────────────────────────────
// Agent identity (spec §2 + Appendix C)
// ─────────────────────────────────────────────────────────────────────────────

/** §3.2 `metadata.agent` — canonical OpenClaw harness identifier. */
export const AGENT_ID = "openclaw";
/** §2 + Appendix C: subject-side abbreviation. Used as `AgentSubject`'s
 *  `subjectToken` so the wire reads `agents.prompt.oc.<owner>.<name>` while
 *  `metadata.agent` keeps the canonical name. */
export const SUBJECT_AGENT_TOKEN = "oc";

/** Service version reported in `$SRV.INFO.version`. Bumped when this
 *  harness's wire-visible behaviour changes; not the protocol version
 *  (which lives in `metadata.protocol_version` and comes from the SDK). */
export const SERVICE_VERSION = "0.3.0";

/** Session-less harnesses MAY omit `metadata.session` or set it to "default"
 *  (spec Appendix C). We set it so callers always see a value in $SRV.INFO. */
export const DEFAULT_SESSION = "default";

/** Time between keep-alive `ack` chunks emitted while a prompt is in flight.
 *  Well under the spec's recommended 60s inactivity timeout (§6.6) so a busy
 *  OpenClaw pipeline doesn't trip the caller's stall detector. */
export const ACK_KEEPALIVE_MS = 20_000;

// ─────────────────────────────────────────────────────────────────────────────
// OpenClaw-specific subject extension
// ─────────────────────────────────────────────────────────────────────────────

/** Agent-initiated outbound messages (pub/sub, not part of the spec). Sits
 *  one level deeper than the verb-first protocol subjects so it doesn't
 *  collide with reserved verbs. */
export function outboundSubject(owner: string, name: string): string {
  return `agents.${SUBJECT_AGENT_TOKEN}.${owner}.${name}.outbound`;
}

// ─────────────────────────────────────────────────────────────────────────────
// NATS header utilities — used by callers that round-trip headers through
// this module. Not protocol-shaped (the agent protocol doesn't define any
// custom headers); kept here as a small NATS sugar layer.
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

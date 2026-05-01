// Server-side heartbeat payload helpers.
//
// Builds and encodes the §8.3 heartbeat wire payload published on
// `agents.hb.{agent}.{owner}.{name}` (§8.1 v0.3) and returned by the
// §8.7 status request/response endpoint. The decoder side
// (`decodeHeartbeatPayload`) and the `HeartbeatPayload` shape live in
// the caller package — both packages share the type.

import type { AgentSubject, HeartbeatPayload } from "@synadia-ai/agents";

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

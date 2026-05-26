// Opinionated reconnect defaults for agent runtimes.
//
// `@nats-io/transport-node`'s defaults — `maxReconnectAttempts: 10`,
// `reconnectTimeWait: 2000ms`, `reconnectJitter: 100ms`,
// `waitOnFirstConnect: false` — fit short-lived clients well, but an
// agent process is supposed to *stay reachable* through laptop sleep,
// flaky home networks, and broker maintenance windows. The defaults
// here flip the polarity: never give up on reconnects, and keep trying
// from the very first attempt even if the server is unreachable at
// startup.
//
// Pure transform, no I/O. Designed to compose with the existing
// per-harness `connect()` pipelines:
//
//     import { connect } from "@nats-io/transport-node";
//     import { withAgentReconnectDefaults } from "@synadia-ai/agents";
//     const nc = await connect(withAgentReconnectDefaults(opts));
//
// Background: synadia-ai/synadia-agents#121.

import type { NodeConnectionOptions } from "@nats-io/transport-node";

/**
 * Reconnect-related defaults applied by {@link withAgentReconnectDefaults}.
 * Exported so callers can introspect / log / override individual values
 * without duplicating the literals.
 *
 * Field-by-field rationale:
 *   - `maxReconnectAttempts: -1`  — never give up. Agents are
 *     supposed to come back when the broker does.
 *   - `reconnectTimeWait: 2000`   — matches the upstream default; pinned
 *     so a future upstream change doesn't silently shift it.
 *   - `reconnectJitter: 200`      — modest bump from the upstream 100ms
 *     to spread the herd a little more on broker recovery.
 *   - `waitOnFirstConnect: true`  — `connect()` retries through a
 *     server that is unreachable at startup, instead of throwing
 *     immediately. Means an operator-misconfigured URL / cert path now
 *     manifests as a stuck "reconnecting…" UI rather than a fast crash.
 *
 * Not pinned here (intentional):
 *   - `reconnect: true`           — already the upstream default.
 *   - `reconnectJitterTLS`        — upstream 1000ms default is generous
 *     enough; no need to over-specify.
 */
export const AGENT_RECONNECT_DEFAULTS: Readonly<Partial<NodeConnectionOptions>> = Object.freeze({
  maxReconnectAttempts: -1,
  reconnectTimeWait: 2000,
  reconnectJitter: 200,
  waitOnFirstConnect: true,
});

/**
 * Return a new options object with {@link AGENT_RECONNECT_DEFAULTS}
 * applied as fallbacks: any field the caller has set (including `0`
 * and `false`) is preserved. The input is never mutated.
 *
 * Use this at the connect call site:
 *
 *     const nc = await connect(withAgentReconnectDefaults(opts));
 *
 * Residual `close` paths even with `maxReconnectAttempts: -1`:
 *   - repeated identical auth errors — nats.js' `ignoreAuthErrorAbort`
 *     defaults to `false` and we don't override it.
 *   - explicit `nc.close()` / `nc.drain()`.
 *
 * Callers should still handle the `close` status case in their
 * `for await (const s of nc.status())` loop so the UI reflects an
 * actually-dead connection (rather than continuing to say
 * "reconnecting…").
 */
export function withAgentReconnectDefaults(opts: NodeConnectionOptions): NodeConnectionOptions {
  // Spread to a fresh object so callers that mutate the result (e.g.
  // `opts.name = "pi-${owner}"` in agents/pi) don't accidentally write
  // through to the caller's original object.
  const out: NodeConnectionOptions = { ...opts };
  // Iterate over the defaults' keys and fill in only where the caller
  // left a hole. Explicit `=== undefined` check (not falsy) so a
  // caller's `maxReconnectAttempts: 0` ("no reconnect at all") survives.
  for (const k of Object.keys(AGENT_RECONNECT_DEFAULTS) as Array<
    keyof typeof AGENT_RECONNECT_DEFAULTS
  >) {
    if (out[k] === undefined) {
      (out as Record<string, unknown>)[k] = AGENT_RECONNECT_DEFAULTS[k];
    }
  }
  return out;
}

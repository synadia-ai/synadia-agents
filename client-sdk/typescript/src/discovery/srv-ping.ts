// Discovery orchestration. Uses `@nats-io/services` to query
// `$SRV.INFO.agents` (§4), filters the responses through the
// agent-shape validator, and applies optional client-side identity filters.

import {
  NoRespondersError,
  type NatsConnection,
  type RequestManyOptions,
} from "@nats-io/nats-core";
import { Svcm } from "@nats-io/services";
import { Agent } from "../agent.js";
import { SERVICE_NAME } from "../internal/service-name.js";
import { buildAgentInfo, type AgentInfo } from "./agent-info.js";

/** Absolute safety cap when using the stall strategy (no explicit timeoutMs). */
export const DEFAULT_DISCOVER_MAX_WAIT_MS = 2000;
/**
 * Idle window after the last reply before the stall strategy returns.
 *
 * Sized to comfortably absorb a transcontinental NATS round-trip
 * (e.g. demo.nats.io reports ~315 ms RTT from a non-US client). At 750 ms
 * we still return well under one perceptible UI tick on a LAN, but no
 * longer time out before the first reply arrives on a WAN — the
 * symptom that issue #31 surfaced. Callers who want a snappier scan on
 * a known-fast broker can still pass `timeoutMs` (timer strategy) or
 * call the lower-level helpers with their own `stall_s` / `stallMs`.
 */
export const DEFAULT_DISCOVER_STALL_MS = 750;

export interface DiscoveryFilter {
  readonly agent?: string;
  readonly owner?: string;
  readonly name?: string;
  readonly session?: string;
  readonly protocolVersion?: string;
}

export interface DiscoverOptions {
  /**
   * When set, `discover()` waits exactly `timeoutMs` milliseconds and
   * returns every responder seen in that window (`strategy: "timer"`).
   * Use this when you need a deterministic scan duration — e.g. a
   * health-check or a periodic refresh.
   *
   * When omitted, `discover()` uses `strategy: "stall"`: it returns
   * {@link DEFAULT_DISCOVER_STALL_MS}ms after the most recent reply, or
   * after {@link DEFAULT_DISCOVER_MAX_WAIT_MS}ms absolute, whichever
   * comes first. This is snappier on lightly-loaded systems where most
   * agents reply within tens of milliseconds.
   */
  readonly timeoutMs?: number;
  /** Client-side AND-matched identity filter. */
  readonly filter?: DiscoveryFilter;
}

export async function discoverAgents(
  nc: NatsConnection,
  defaultInactivityTimeoutMs: number,
  closeSignal: AbortSignal,
  opts: DiscoverOptions = {},
): Promise<Agent[]> {
  const requestOpts: RequestManyOptions =
    opts.timeoutMs !== undefined
      ? { strategy: "timer", maxWait: opts.timeoutMs }
      : {
          strategy: "stall",
          maxWait: DEFAULT_DISCOVER_MAX_WAIT_MS,
          stall: DEFAULT_DISCOVER_STALL_MS,
        };
  const svcm = new Svcm(nc);
  const client = svcm.client(requestOpts);

  const found: Agent[] = [];
  try {
    const infos = await client.info(SERVICE_NAME);
    for await (const info of infos) {
      const agentInfo = buildAgentInfo(info);
      if (agentInfo && matchesFilter(agentInfo, opts.filter)) {
        found.push(new Agent(nc, agentInfo, defaultInactivityTimeoutMs, closeSignal));
      }
    }
  } catch (err) {
    // NATS server replies NoResponders the moment there are zero
    // subscribers on `$SRV.INFO.agents` — i.e. no agents are
    // registered. Treat that as an empty discovery, not an exception.
    if (err instanceof NoRespondersError) return [];
    throw err;
  }
  return found;
}

export function matchesFilter(info: AgentInfo, filter?: DiscoveryFilter): boolean {
  if (!filter) return true;
  if (filter.agent !== undefined && info.agent !== filter.agent) return false;
  if (filter.owner !== undefined && info.owner !== filter.owner) return false;
  if (filter.name !== undefined && info.name !== filter.name) return false;
  if (filter.session !== undefined && info.session !== filter.session) return false;
  if (filter.protocolVersion !== undefined && info.protocolVersion !== filter.protocolVersion) {
    return false;
  }
  return true;
}

/** On-demand reachability check for a single instance (§8.4). */
export async function pingInstance(
  nc: NatsConnection,
  instanceId: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const maxWait = opts.timeoutMs ?? 2000;
  const svcm = new Svcm(nc);
  const client = svcm.client({ strategy: "timer", maxWait });
  try {
    const replies = await client.ping(SERVICE_NAME, instanceId);
    for await (const _r of replies) {
      return true;
    }
    return false;
  } catch (err) {
    // NATS server returns NoResponders immediately when no subscribers match
    // the control subject — meaning the instance id is unknown.
    if (err instanceof NoRespondersError) return false;
    throw err;
  }
}

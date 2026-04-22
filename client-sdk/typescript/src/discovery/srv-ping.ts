// Discovery orchestration. Uses `@nats-io/services` to query
// `$SRV.INFO.agents` (§4), filters the responses through the
// agent-shape validator, and applies optional client-side identity filters.

import { NoRespondersError, type NatsConnection } from "@nats-io/nats-core";
import { Svcm } from "@nats-io/services";
import { SERVICE_NAME } from "../internal/service-name.js";
import { buildDiscoveredAgent, type DiscoveredAgent } from "./discovered-agent.js";

export interface DiscoveryFilter {
  readonly agent?: string;
  readonly owner?: string;
  readonly name?: string;
  readonly session?: string;
  readonly protocolVersion?: string;
}

export interface DiscoverOptions {
  /** Maximum time to wait for responses. Default: 2000ms. */
  readonly timeoutMs?: number;
  /** Client-side AND-matched identity filter. */
  readonly filter?: DiscoveryFilter;
}

export async function discoverAgents(
  nc: NatsConnection,
  opts: DiscoverOptions = {},
): Promise<DiscoveredAgent[]> {
  const maxWait = opts.timeoutMs ?? 2000;
  const svcm = new Svcm(nc);
  const client = svcm.client({ strategy: "timer", maxWait });

  const found: DiscoveredAgent[] = [];
  try {
    const infos = await client.info(SERVICE_NAME);
    for await (const info of infos) {
      const agent = buildDiscoveredAgent(info);
      if (agent && matchesFilter(agent, opts.filter)) {
        found.push(agent);
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

export function matchesFilter(agent: DiscoveredAgent, filter?: DiscoveryFilter): boolean {
  if (!filter) return true;
  if (filter.agent !== undefined && agent.agent !== filter.agent) return false;
  if (filter.owner !== undefined && agent.owner !== filter.owner) return false;
  if (filter.name !== undefined && agent.name !== filter.name) return false;
  if (filter.session !== undefined && agent.session !== filter.session) return false;
  if (filter.protocolVersion !== undefined && agent.protocolVersion !== filter.protocolVersion) {
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

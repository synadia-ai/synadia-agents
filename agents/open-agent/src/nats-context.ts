// Thin wrapper that resolves a NATS connection from a CLI context name or
// a `NATS_URL` env var. The SDK already owns the heavy lifting; this is
// just the bridge's CLI flag plumbing.

import { connect, type NodeConnectionOptions } from "@nats-io/transport-node";
import { loadContextOptions, parseNatsUrl } from "@synadia-ai/agents";
import type { NatsConnection } from "@nats-io/nats-core";

export interface ResolveNatsOptions {
  /** Saved `nats` CLI context name; `"current"` resolves the selected one. */
  readonly natsContext?: string;
  /** Direct URL — overrides the context if set. */
  readonly natsUrl?: string;
}

export async function resolveConnectionOptions(
  opts: ResolveNatsOptions,
): Promise<NodeConnectionOptions> {
  if (opts.natsUrl !== undefined && opts.natsUrl.length > 0) {
    return parseNatsUrl(opts.natsUrl);
  }
  if (opts.natsContext !== undefined && opts.natsContext.length > 0) {
    return loadContextOptions(opts.natsContext);
  }
  return parseNatsUrl("nats://127.0.0.1:4222");
}

export async function connectFrom(opts: ResolveNatsOptions): Promise<NatsConnection> {
  const co = await resolveConnectionOptions(opts);
  return connect(co);
}

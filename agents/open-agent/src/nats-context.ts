// Thin wrapper that resolves a NATS connection from a CLI context name or
// a `NATS_URL` env var. The SDK already owns the heavy lifting; this is
// just the bridge's CLI flag plumbing.

import { connect } from "@nats-io/transport-node";
import {
  resolveNatsConnectionBundle,
  withAgentReconnectDefaults,
  type NatsConnectionBundle,
  type NatsConnectionSource,
} from "@synadia-ai/agents";
import type { NatsConnection } from "@nats-io/nats-core";

export interface ResolveNatsOptions {
  /** Saved `nats` CLI context name; `"current"` resolves the selected one. */
  readonly natsContext?: string;
  /** Direct URL. A selected context wins when both values are present. */
  readonly natsUrl?: string;
  /** Derive a sender signer from the selected connection source. Default: off. */
  readonly senderIdentity?: "off" | "signed";
}

export async function resolveConnectionBundle(
  opts: ResolveNatsOptions,
): Promise<NatsConnectionBundle> {
  const source: NatsConnectionSource = opts.natsContext !== undefined && opts.natsContext.length > 0
    ? { context: opts.natsContext }
    : opts.natsUrl !== undefined && opts.natsUrl.length > 0
      ? { url: opts.natsUrl }
      : { url: "nats://127.0.0.1:4222" };
  const bundle = opts.senderIdentity === "signed"
    ? await resolveNatsConnectionBundle(source, { identity: "signed" })
    : await resolveNatsConnectionBundle(source);
  Object.assign(bundle.connectionOptions, withAgentReconnectDefaults(bundle.connectionOptions));
  return bundle;
}

export interface ConnectedNats {
  readonly nc: NatsConnection;
  readonly bundle: NatsConnectionBundle;
}

export async function connectFrom(opts: ResolveNatsOptions): Promise<ConnectedNats> {
  const bundle = await resolveConnectionBundle(opts);
  try {
    return { nc: await connect(bundle.connectionOptions), bundle };
  } catch (error) {
    bundle.wipe();
    throw error;
  }
}

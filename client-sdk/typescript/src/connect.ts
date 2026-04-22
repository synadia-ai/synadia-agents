// Top-level factories: `connect()` opens a new NATS connection; `attach()`
// wraps a caller-owned connection. Both return a `Client`.
//
// `connect()` accepts either `servers` directly (and/or `nats` connection
// options), a `context` selector (spec §10.2) that loads one of the JSON
// files `nats context` writes, or both — in which case explicit fields
// override the context-derived ones.

import type { NatsConnection } from "@nats-io/nats-core";
import { connect as natsConnect, type NodeConnectionOptions } from "@nats-io/transport-node";
import { Client, type ClientOptions } from "./client.js";
import { type ContextSelector, loadNatsContext } from "./context.js";

export interface ConnectOptions extends ClientOptions {
  /**
   * NATS server URL(s). Required unless `context` is set, in which case
   * the context's `url` provides the default — `servers` still wins if
   * both are present.
   */
  readonly servers?: string | string[];
  /**
   * Load connection settings from a NATS CLI context per spec §10.2.
   * Accepts a context name, `"current"` / `true` for the
   * currently-selected context (`nats context select` output plus
   * `$NATS_CONTEXT` override), or `undefined` to skip.
   */
  readonly context?: ContextSelector;
  /**
   * Additional `@nats-io/transport-node` connection options. These
   * shallow-merge OVER any context-derived options so callers can
   * override individual fields (e.g. `maxReconnectAttempts`) without
   * re-specifying the whole auth bundle.
   */
  readonly nats?: Omit<NodeConnectionOptions, "servers">;
}

export interface AttachOptions extends ClientOptions {
  /** A pre-connected `NatsConnection` — the caller retains ownership. */
  readonly nc: NatsConnection;
}

/** Open a new NATS connection and wrap it in a {@link Client}. */
export async function connect(options: ConnectOptions): Promise<Client> {
  const resolved = await resolveConnectArgs(options);
  const nc = await natsConnect(resolved);
  return new Client({ ...options, nc, ownsConnection: true });
}

/** Wrap an existing {@link NatsConnection} in a {@link Client}. */
export function attach(options: AttachOptions): Client {
  return new Client({ ...options, ownsConnection: false });
}

/**
 * Resolve the final `NodeConnectionOptions` from `ConnectOptions`:
 * merges context-derived fields with explicit `servers` / `nats`.
 */
async function resolveConnectArgs(options: ConnectOptions): Promise<NodeConnectionOptions> {
  let contextServers: ReadonlyArray<string> | undefined;
  let contextOptions: Omit<NodeConnectionOptions, "servers"> = {};
  if (options.context !== undefined) {
    const ctx = await loadNatsContext(options.context);
    contextServers = ctx.servers;
    contextOptions = ctx.connectionOptions;
  }

  const servers = options.servers ?? contextServers;
  if (servers === undefined) {
    throw new Error("connect(): either `servers` or `context` must be set (neither provided)");
  }

  // Shallow-merge: caller-supplied `nats` wins per-field.
  const serversOption: string | string[] = typeof servers === "string" ? servers : [...servers];
  const merged: NodeConnectionOptions = {
    ...contextOptions,
    ...(options.nats ?? {}),
    servers: serversOption,
  };
  return merged;
}

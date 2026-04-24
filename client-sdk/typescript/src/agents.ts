// `Agents` — owner of the heartbeat wildcard subscription and the entry
// point for discovery. Orchestrates subscribe-before-discover per §8.5
// and returns live `Agent` handles.
//
// Construct with a pre-opened `NatsConnection`:
//
//   import { connect } from "@nats-io/transport-node";
//   import { Agents } from "@synadia/agents";
//
//   const nc = await connect({ servers: "nats://localhost:4222" });
//   const agents = new Agents({ nc });
//   const found = await agents.discover({ timeoutMs: 2_000 });
//   for await (const msg of await found[0]!.prompt("hi")) { ... }
//
// The caller owns `nc`. `agents.close()` tears down SDK-owned state only;
// closing the underlying connection is the caller's responsibility.

import type { NatsConnection } from "@nats-io/nats-core";
import type { Agent } from "./agent.js";
import { discoverAgents, pingInstance, type DiscoverOptions } from "./discovery/srv-ping.js";
import { HeartbeatTracker, type Liveness } from "./heartbeat/tracker.js";
import { type HeartbeatPayload } from "./heartbeat/payload.js";
import { type Logger, SILENT_LOGGER } from "./internal/logger.js";

/** Default per-stream inactivity timeout (§6.6) — 60 seconds. */
export const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 60_000;

export interface AgentsOptions {
  /** A pre-connected `NatsConnection`. Caller retains ownership. */
  readonly nc: NatsConnection;
  /** Default per-stream inactivity timeout in milliseconds. Default: 60_000. */
  readonly streamInactivityTimeoutMs?: number;
  /** Pluggable logger. Default: silent. */
  readonly logger?: Logger;
}

export class Agents {
  readonly #nc: NatsConnection;
  readonly #tracker: HeartbeatTracker;
  readonly #logger: Logger;
  readonly #streamInactivityTimeoutMs: number;
  readonly #closeController = new AbortController();
  #closed = false;

  constructor(options: AgentsOptions) {
    this.#nc = options.nc;
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#streamInactivityTimeoutMs =
      options.streamInactivityTimeoutMs ?? DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS;
    this.#tracker = new HeartbeatTracker(options.nc, this.#logger);
  }

  /** The underlying NATS connection. */
  get connection(): NatsConnection {
    return this.#nc;
  }

  /** Default per-stream inactivity timeout applied to every `Agent.prompt()`. */
  get streamInactivityTimeoutMs(): number {
    return this.#streamInactivityTimeoutMs;
  }

  /**
   * Discover protocol-compliant agents reachable on the NATS connection.
   * Returns a live `Agent[]` — each entry is directly callable via `.prompt()`.
   *
   * The first call to `discover()` lazily starts the heartbeat wildcard
   * subscription BEFORE publishing `$SRV.PING`, enforcing §8.5 automatically.
   *
   * Two instances of the same logical agent (same `(agent, owner, name)`)
   * show up as separate entries with distinct `instanceId`s; callers who
   * want one-per-logical-agent can group with `Map.groupBy`.
   */
  async discover(opts: DiscoverOptions = {}): Promise<Agent[]> {
    this.#ensureOpen();
    if (!this.#tracker.isStarted) {
      // tracker.start() flushes internally so the SUB is at the server before
      // we send $SRV.PING (§8.5 subscribe-before-discover).
      await this.#tracker.start();
    }
    return discoverAgents(
      this.#nc,
      this.#streamInactivityTimeoutMs,
      this.#closeController.signal,
      opts,
    );
  }

  /**
   * Ensure the heartbeat wildcard subscription is established. Normally
   * called implicitly by `discover()` / `onHeartbeat()`; use this when you
   * want to start tracking before either.
   */
  async startTracking(): Promise<void> {
    this.#ensureOpen();
    await this.#tracker.start();
  }

  /** Current passively-tracked liveness for an instance, or `null` if no heartbeat seen. */
  liveness(instanceId: string): Liveness | null {
    return this.#tracker.liveness(instanceId);
  }

  /**
   * Subscribe to heartbeats for a single instance. Returns an unsubscribe
   * function. Tracker is started lazily if needed — call `startTracking()`
   * beforehand (and await it) if you need to guarantee the subscription is
   * live before a specific moment.
   */
  onHeartbeat(instanceId: string, listener: (payload: HeartbeatPayload) => void): () => void {
    if (!this.#tracker.isStarted) {
      // Fire-and-forget: lazy start. Callers who need determinism use
      // startTracking() first. (Flush happens inside tracker.start.)
      void this.#tracker.start();
    }
    return this.#tracker.onHeartbeat(instanceId, listener);
  }

  /**
   * On-demand reachability check for a single instance via
   * `$SRV.PING.agents.{instanceId}` (§8.4).
   *
   * Returns `true` as soon as any response arrives within the timeout;
   * `false` on timeout.
   */
  async ping(instanceId: string, opts: { timeoutMs?: number } = {}): Promise<boolean> {
    this.#ensureOpen();
    return pingInstance(this.#nc, instanceId, opts);
  }

  /**
   * Close the SDK-owned state. Cancels all in-flight prompt streams (they
   * throw AbortError from the iterator) and unsubscribes the heartbeat
   * wildcard. The underlying `NatsConnection` is untouched — the caller
   * who opened it is responsible for closing it.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeController.abort(new Error("@synadia/agents: Agents is closed"));
    await this.#tracker.stop();
  }

  /** True if `close()` has been called. */
  get isClosed(): boolean {
    return this.#closed;
  }

  #ensureOpen(): void {
    if (this.#closed) {
      throw new Error("@synadia/agents: Agents is closed");
    }
  }
}

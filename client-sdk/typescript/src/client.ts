// The `Client` class — owner of the NATS connection wrapper and the
// heartbeat wildcard subscription. Orchestrates discover-before-subscribe
// per §8.5 and vends `RemoteAgent` handles.

import type { NatsConnection } from "@nats-io/nats-core";
import type { DiscoveredAgent } from "./discovery/discovered-agent.js";
import { discoverAgents, pingInstance, type DiscoverOptions } from "./discovery/srv-ping.js";
import { HeartbeatTracker, type HeartbeatScope, type Liveness } from "./heartbeat/tracker.js";
import { type HeartbeatPayload } from "./heartbeat/payload.js";
import { type Logger, SILENT_LOGGER } from "./internal/logger.js";
import { RemoteAgent } from "./remote-agent.js";

/** Default per-stream inactivity timeout (§6.6) — 60 seconds. */
export const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 60_000;

export interface ClientOptions {
  /** Informational label for this caller — appears in logs, not on the wire. */
  readonly name: string;
  /** Scope the heartbeat wildcard to a specific agent/owner (§8.5). */
  readonly heartbeatScope?: HeartbeatScope;
  /** Per-stream inactivity timeout in milliseconds. Default: 60_000. */
  readonly streamInactivityTimeoutMs?: number;
  /** Pluggable logger. Default: silent. */
  readonly logger?: Logger;
}

interface ClientInternalOptions extends ClientOptions {
  readonly nc: NatsConnection;
  /** True when the `Client` opened the connection and is therefore responsible for closing it. */
  readonly ownsConnection: boolean;
}

export class Client {
  readonly #nc: NatsConnection;
  readonly #ownsConnection: boolean;
  readonly #tracker: HeartbeatTracker;
  readonly #logger: Logger;
  readonly #name: string;
  readonly #streamInactivityTimeoutMs: number;
  readonly #closeController = new AbortController();
  #closed = false;

  constructor(options: ClientInternalOptions) {
    this.#nc = options.nc;
    this.#ownsConnection = options.ownsConnection;
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#name = options.name;
    this.#streamInactivityTimeoutMs =
      options.streamInactivityTimeoutMs ?? DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS;
    this.#tracker = new HeartbeatTracker(options.nc, options.heartbeatScope ?? {}, this.#logger);
  }

  /** The caller identity provided at construction. */
  get name(): string {
    return this.#name;
  }

  /** The underlying NATS connection. */
  get connection(): NatsConnection {
    return this.#nc;
  }

  /** Default per-stream inactivity timeout used by `RemoteAgent.prompt`. */
  get streamInactivityTimeoutMs(): number {
    return this.#streamInactivityTimeoutMs;
  }

  /**
   * Discover protocol-compliant agents reachable on the NATS connection.
   *
   * The first call to `discover()` lazily starts the heartbeat wildcard
   * subscription BEFORE publishing `$SRV.PING`, enforcing §8.5 automatically.
   */
  async discover(opts: DiscoverOptions = {}): Promise<DiscoveredAgent[]> {
    this.#ensureOpen();
    if (!this.#tracker.isStarted) {
      // tracker.start() flushes internally so the SUB is at the server before
      // we send $SRV.PING (§8.5 subscribe-before-discover).
      await this.#tracker.start();
    }
    return discoverAgents(this.#nc, opts);
  }

  /** Bind a handle to a discovered agent. */
  bind(agent: DiscoveredAgent): RemoteAgent {
    this.#ensureOpen();
    return new RemoteAgent(
      this.#nc,
      agent,
      this.#streamInactivityTimeoutMs,
      this.#closeController.signal,
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
   * beforehand (and await it) if you need to guarantee subscription is live
   * before a specific moment.
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
   * Close the client. Cancels all in-flight prompt streams (they throw an
   * AbortError from the iterator), unsubscribes the heartbeat wildcard,
   * and — if the client opened the underlying NATS connection — closes
   * it as well.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeController.abort(new Error("@synadia/agents: Client is closed"));
    await this.#tracker.stop();
    if (this.#ownsConnection) {
      await this.#nc.close();
    }
  }

  /** True if `close()` has been called. */
  get isClosed(): boolean {
    return this.#closed;
  }

  #ensureOpen(): void {
    if (this.#closed) {
      throw new Error("@synadia/agents: Client is closed");
    }
  }
}

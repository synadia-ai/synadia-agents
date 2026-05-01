// Heartbeat tracker: subscribes to the heartbeat wildcard (§8.5) and
// maintains per-instance liveness (§8.1, §8.2). Keyed on `instance_id`
// from the heartbeat payload — NOT on the subject — so multiple
// instances of the same logical agent (§3.3) stay distinguishable.

import type { NatsConnection, Subscription } from "@nats-io/nats-core";
import { type HeartbeatPayload, decodeHeartbeatPayload } from "./payload.js";
import { type Logger, SILENT_LOGGER } from "../internal/logger.js";

export interface Liveness {
  readonly instanceId: string;
  readonly lastSeen: Date;
  readonly intervalS: number;
  readonly isOnline: boolean;
}

/** Default offline threshold multiplier: online iff last seen within `3 × interval_s` (§8.2). */
export const DEFAULT_LIVENESS_SLACK = 3;

/** Heartbeat wildcard (§8.1 v0.3): `agents.hb.<agent>.<owner>.<name>`. */
export const HEARTBEAT_SUBJECT = "agents.hb.*.*.*";

type HeartbeatListener = (payload: HeartbeatPayload) => void;

interface Entry {
  readonly payload: HeartbeatPayload;
  readonly lastSeen: Date;
}

export class HeartbeatTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly allListeners = new Set<HeartbeatListener>();
  private readonly scopedListeners = new Map<string, Set<HeartbeatListener>>();
  private subscription: Subscription | null = null;

  constructor(
    private readonly nc: NatsConnection,
    private readonly logger: Logger = SILENT_LOGGER,
  ) {}

  get subject(): string {
    return HEARTBEAT_SUBJECT;
  }

  get isStarted(): boolean {
    return this.subscription !== null;
  }

  async start(): Promise<void> {
    if (this.subscription) return;
    this.subscription = this.nc.subscribe(this.subject, {
      callback: (err, msg) => {
        if (err) {
          this.logger.warn("heartbeat subscription error", { error: String(err) });
          return;
        }
        let raw: unknown;
        try {
          raw = msg.json();
        } catch {
          this.logger.debug("dropping non-JSON heartbeat", { subject: msg.subject });
          return;
        }
        const payload = decodeHeartbeatPayload(raw);
        if (!payload) {
          this.logger.debug("dropping malformed heartbeat", { subject: msg.subject });
          return;
        }
        this.entries.set(payload.instanceId, { payload, lastSeen: new Date() });
        this.dispatch(payload);
      },
    });
    // Ensure the SUB is registered at the server before the caller proceeds
    // (subscribe-before-discover per §8.5, tracker-then-anything in general).
    await this.nc.flush();
  }

  async stop(): Promise<void> {
    if (!this.subscription) return;
    const sub = this.subscription;
    this.subscription = null;
    sub.unsubscribe();
    await sub.closed;
  }

  liveness(instanceId: string, now: Date = new Date()): Liveness | null {
    const entry = this.entries.get(instanceId);
    if (!entry) return null;
    const ageS = (now.getTime() - entry.lastSeen.getTime()) / 1000;
    // Inclusive boundary (§8.2): a heartbeat that arrived exactly
    // `slack * interval_s` seconds ago is considered online — matches the
    // Python SDK's `Liveness.is_online` and the docstring's "within" wording.
    const isOnline = ageS <= DEFAULT_LIVENESS_SLACK * entry.payload.intervalS;
    return Object.freeze({
      instanceId,
      lastSeen: entry.lastSeen,
      intervalS: entry.payload.intervalS,
      isOnline,
    });
  }

  /** Subscribe to all heartbeat events. Returns an unsubscribe function. */
  onAnyHeartbeat(listener: HeartbeatListener): () => void {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  }

  /** Subscribe to heartbeats for a single instance. Returns an unsubscribe function. */
  onHeartbeat(instanceId: string, listener: HeartbeatListener): () => void {
    let set = this.scopedListeners.get(instanceId);
    if (!set) {
      set = new Set();
      this.scopedListeners.set(instanceId, set);
    }
    set.add(listener);
    return () => {
      const s = this.scopedListeners.get(instanceId);
      if (s) {
        s.delete(listener);
        if (s.size === 0) this.scopedListeners.delete(instanceId);
      }
    };
  }

  private dispatch(payload: HeartbeatPayload): void {
    for (const listener of this.allListeners) {
      try {
        listener(payload);
      } catch (e) {
        this.logger.warn("heartbeat listener threw", { error: String(e) });
      }
    }
    const scoped = this.scopedListeners.get(payload.instanceId);
    if (scoped) {
      for (const listener of scoped) {
        try {
          listener(payload);
        } catch (e) {
          this.logger.warn("heartbeat listener threw", { error: String(e) });
        }
      }
    }
  }
}

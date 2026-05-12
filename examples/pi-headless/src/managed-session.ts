// Per-session glue: wraps a live PI `AgentSession` + a SDK `ReferenceAgent`
// into a single unit. Handles envelope parsing, request queueing for serial
// drain (PI sessions are not re-entrant — the old bridge serialised them
// the same way), typed-chunk streaming, error headers, and disposal.

import type { NatsConnection } from "@nats-io/nats-core";
import type { ServiceMsg } from "@nats-io/services";
import {
  ProtocolError,
  decodeEnvelope,
  type RequestAttachment,
} from "@synadia-ai/agents";
import { encodeChunk } from "@synadia-ai/agent-service";
import { ReferenceAgent } from "@synadia-ai/agent-service/testing";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { cleanupStaged, decorateWithAttachments, stageAttachments } from "./attachments.js";
import {
  sessionHeartbeatSubject,
  sessionPromptSubject,
  sessionStatusSubject,
} from "./subjects.js";

export interface ManagedSessionOptions {
  readonly nc: NatsConnection;
  readonly owner: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly maxLifetimeS: number;
  readonly piSession: AgentSession;
}

export interface SessionSummary {
  readonly session_id: string;
  readonly subject: string;
  readonly heartbeat_subject: string;
  readonly status_subject: string;
  readonly cwd: string;
  readonly model: string | undefined;
  readonly thinking_level: string | undefined;
  readonly max_lifetime_s: number;
  readonly remaining_lifetime_s: number;
  readonly active_request: boolean;
  readonly queued_requests: number;
  readonly created_at: string;
  readonly last_activity: string;
}

interface PendingRequest {
  readonly requestId: string;
  readonly msg: ServiceMsg;
  readonly body: string;
  readonly createdAt: number;
  readonly stagedDir: string | undefined;
}

// 5s — snappy enough that the dashboard's stale-eviction loop
// (3× intervalS) drops a vanished controller in ~15s. The SDK's
// `DEFAULT_HEARTBEAT_INTERVAL_S` stays at 30s as a sensible
// third-party default; first-party harnesses opt into the snappier
// cadence.
const HEARTBEAT_INTERVAL_S = 5;

export class ManagedSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly maxLifetimeS: number;
  readonly createdAt: number;
  readonly subject: string;
  readonly heartbeatSubject: string;
  readonly statusSubject: string;

  private readonly nc: NatsConnection;
  private readonly owner: string;
  private readonly piSession: AgentSession;
  private readonly refAgent: ReferenceAgent;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly requestQueue: string[] = [];
  private activeRequestId: string | null = null;
  private lastActivity: number;
  private requestCounter = 0;
  private disposed = false;

  constructor(opts: ManagedSessionOptions) {
    this.nc = opts.nc;
    this.owner = opts.owner;
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.thinkingLevel = opts.thinkingLevel;
    this.maxLifetimeS = opts.maxLifetimeS;
    this.piSession = opts.piSession;
    this.createdAt = Date.now();
    this.lastActivity = this.createdAt;
    this.subject = sessionPromptSubject(this.owner, this.sessionId);
    this.heartbeatSubject = sessionHeartbeatSubject(this.owner, this.sessionId);
    this.statusSubject = sessionStatusSubject(this.owner, this.sessionId);

    const extraMetadata: Record<string, string> = {
      role: "session",
      cwd: this.cwd,
      max_lifetime_s: String(this.maxLifetimeS),
    };
    if (this.model) extraMetadata["model"] = this.model;
    if (this.thinkingLevel) extraMetadata["thinking_level"] = this.thinkingLevel;

    // `maxPayload` is intentionally omitted — `ReferenceAgent` defaults to
    // the broker's negotiated `nc.info.max_payload` (e.g. 8 MB on NGS, 1 MB
    // on a default `nats-server`), which is exactly what we want each
    // session to advertise.
    this.refAgent = new ReferenceAgent({
      nc: this.nc,
      agent: "pi-headless",
      owner: this.owner,
      name: this.sessionId,
      session: this.sessionId,
      description: `pi-headless session ${this.sessionId} (${this.cwd})`,
      version: "0.4.0",
      attachmentsOk: true,
      heartbeatIntervalS: HEARTBEAT_INTERVAL_S,
      extraMetadata,
      promptHandler: (msg) => this.handlePrompt(msg),
    });
  }

  async start(): Promise<void> {
    await this.refAgent.start();
  }

  get instanceId(): string {
    return this.refAgent.instanceId;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  summary(): SessionSummary {
    const now = Date.now();
    const elapsed = Math.floor((now - this.createdAt) / 1000);
    const remaining = this.maxLifetimeS > 0 ? Math.max(0, this.maxLifetimeS - elapsed) : 0;
    return {
      session_id: this.sessionId,
      subject: this.subject,
      heartbeat_subject: this.heartbeatSubject,
      status_subject: this.statusSubject,
      cwd: this.cwd,
      model: this.model,
      thinking_level: this.thinkingLevel,
      max_lifetime_s: this.maxLifetimeS,
      remaining_lifetime_s: remaining,
      active_request: this.activeRequestId !== null,
      queued_requests: this.requestQueue.length,
      created_at: new Date(this.createdAt).toISOString(),
      last_activity: new Date(this.lastActivity).toISOString(),
    };
  }

  // ─── Prompt path ────────────────────────────────────────────────────────────

  private async handlePrompt(msg: ServiceMsg): Promise<void> {
    if (this.disposed) {
      // Send an error header before the §6.5 terminator so callers can
      // tell "session was stopped" apart from "stream completed cleanly
      // with no chunks." Both have a zero-byte body, so without the
      // error header they look identical on the wire.
      try {
        msg.respondError(503, "session stopped");
      } catch {
        /* connection gone */
      }
      try {
        msg.respond("");
      } catch {
        /* connection gone */
      }
      return;
    }

    // Reject prompts to a session whose lifetime ran out. The manager's
    // sweep loop disposes expired sessions on a tick; without this guard,
    // a prompt that arrives between expiry and the next sweep would be
    // served normally — accepting work the session is about to drop.
    if (this.expired()) {
      try {
        msg.respondError(410, "session expired");
      } catch {
        /* connection gone */
      }
      try {
        msg.respond("");
      } catch {
        /* connection gone */
      }
      return;
    }

    let envelope: ReturnType<typeof decodeEnvelope>;
    try {
      envelope = decodeEnvelope(msg.data);
    } catch (e) {
      if (e instanceof ProtocolError) {
        try {
          msg.respondError(400, e.message);
        } catch {
          /* noop */
        }
        try {
          msg.respond("");
        } catch {
          /* noop */
        }
        return;
      }
      throw e;
    }

    let stagedDir: string | undefined;
    let body = envelope.prompt;
    const attachments: ReadonlyArray<RequestAttachment> = envelope.attachments ?? [];
    if (attachments.length > 0) {
      try {
        const staged = await stageAttachments(this.sessionId, attachments);
        stagedDir = staged.dir;
        body = decorateWithAttachments(body, staged.paths);
      } catch (e) {
        try {
          msg.respondError(400, `failed to stage attachments: ${(e as Error).message}`);
          msg.respond("");
        } catch {
          /* noop */
        }
        return;
      }
    }

    const requestId = `${this.sessionId}-${++this.requestCounter}`;
    this.pendingRequests.set(requestId, {
      requestId,
      msg,
      body,
      createdAt: Date.now(),
      stagedDir,
    });
    this.requestQueue.push(requestId);
    this.lastActivity = Date.now();
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.disposed) return;
    if (this.activeRequestId !== null) return;
    const next = this.requestQueue.shift();
    if (!next) return;
    const pr = this.pendingRequests.get(next);
    if (!pr) {
      void this.drain();
      return;
    }

    this.activeRequestId = next;
    this.lastActivity = Date.now();

    let unsubscribe: (() => void) | undefined;
    try {
      try {
        pr.msg.respond(encodeChunk({ type: "status", status: "ack" }));
      } catch {
        /* noop */
      }

      unsubscribe = this.piSession.subscribe((ev: unknown) => {
        const delta = extractTextDelta(ev);
        if (delta !== undefined) {
          try {
            pr.msg.respond(encodeChunk({ type: "response", text: delta }));
          } catch {
            /* noop */
          }
        }
      });

      await this.piSession.prompt(pr.body);
    } catch (e) {
      try {
        pr.msg.respondError(500, (e as Error).message || "agent error");
      } catch {
        /* noop */
      }
    } finally {
      try {
        unsubscribe?.();
      } catch {
        /* noop */
      }
      try {
        pr.msg.respond("");
      } catch {
        /* noop */
      }
      if (pr.stagedDir) {
        void cleanupStaged({ dir: pr.stagedDir, paths: [] });
      }
      this.pendingRequests.delete(next);
      this.activeRequestId = null;
      this.lastActivity = Date.now();

      if (!this.disposed && this.requestQueue.length > 0) {
        setImmediate(() => void this.drain());
      }
    }
  }

  // ─── Lifetime / pruning (called by PiSessionManager) ───────────────────────

  /** Returns true if this session has outlived its maxLifetime. */
  expired(now: number = Date.now()): boolean {
    if (this.maxLifetimeS <= 0) return false;
    return now - this.createdAt > this.maxLifetimeS * 1000;
  }

  /** Evict requests older than cutoffMs that aren't currently active. */
  pruneStale(cutoffMs: number): number {
    let removed = 0;
    const cutoff = Date.now() - cutoffMs;
    for (const [id, pr] of this.pendingRequests) {
      if (id === this.activeRequestId) continue;
      if (pr.createdAt < cutoff) {
        this.pendingRequests.delete(id);
        const qi = this.requestQueue.indexOf(id);
        if (qi >= 0) this.requestQueue.splice(qi, 1);
        try {
          pr.msg.respond("");
        } catch {
          /* noop */
        }
        removed += 1;
      }
    }
    return removed;
  }

  // ─── Disposal ──────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // Terminate in-flight replies so callers don't hang.
    for (const pr of this.pendingRequests.values()) {
      try {
        pr.msg.respond("");
      } catch {
        /* noop */
      }
    }
    this.pendingRequests.clear();
    this.requestQueue.length = 0;

    try {
      await this.refAgent.stop();
    } catch (e) {
      process.stderr.write(
        `pi-headless: refAgent.stop() failed for ${this.sessionId}: ${(e as Error).message}\n`,
      );
    }
    try {
      this.piSession.dispose();
    } catch (e) {
      process.stderr.write(
        `pi-headless: piSession.dispose() failed for ${this.sessionId}: ${(e as Error).message}\n`,
      );
    }
  }
}

/**
 * Defensive event unwrapper for PI's `session.subscribe` stream. The event
 * shape is `{ type: "message_update", assistantMessageEvent: { type:
 * "text_delta", delta: string } }`; any other shape returns undefined.
 */
function extractTextDelta(ev: unknown): string | undefined {
  if (!ev || typeof ev !== "object") return undefined;
  const e = ev as Record<string, unknown>;
  if (e["type"] !== "message_update") return undefined;
  const ame = e["assistantMessageEvent"];
  if (!ame || typeof ame !== "object") return undefined;
  const inner = ame as Record<string, unknown>;
  if (inner["type"] !== "text_delta") return undefined;
  const delta = inner["delta"];
  return typeof delta === "string" && delta.length > 0 ? delta : undefined;
}

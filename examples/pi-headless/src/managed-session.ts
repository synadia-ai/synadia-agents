// Per-session glue: wraps a live PI AgentSession with a production
// AgentService. AgentService owns sender admission, acknowledgements,
// keep-alives, error frames, status, heartbeats, and stream termination;
// this class owns PI's serial prompt queue and model-output streaming.

import type { NatsConnection } from "@nats-io/nats-core";
import {
  ProtocolError,
  formatSender,
  type MinSenderTrust,
  type RequestEnvelope,
  type SenderSigner,
} from "@synadia-ai/agents";
import { AgentService, type PromptResponse } from "@synadia-ai/agent-service";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
  cleanupStaged,
  decorateWithAttachments,
  stageAttachments,
} from "./attachments.js";
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
  /** Connection-bound signer shared by every logical session. */
  readonly signer?: SenderSigner;
  readonly minSenderTrust?: MinSenderTrust;
  readonly logger?: (line: string) => void;
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
  readonly response: PromptResponse;
  readonly body: string;
  readonly createdAt: number;
  readonly stagedDir: string | undefined;
  readonly completion: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
}

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
  private readonly service: AgentService;
  private readonly log: (line: string) => void;
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
    this.log = opts.logger ?? ((line) => process.stderr.write(`${line}\n`));
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
    if (this.thinkingLevel)
      extraMetadata["thinking_level"] = this.thinkingLevel;

    this.service = new AgentService({
      nc: this.nc,
      agent: "pi-headless",
      owner: this.owner,
      name: this.sessionId,
      session: this.sessionId,
      description: `pi-headless session ${this.sessionId} (${this.cwd})`,
      version: "0.4.0",
      attachmentsOk: true,
      heartbeatIntervalS: HEARTBEAT_INTERVAL_S,
      minSenderTrust: opts.minSenderTrust ?? "any",
      ...(opts.signer ? { identity: { signer: opts.signer } } : {}),
      extraMetadata,
    });
    this.service.onPrompt((envelope, response) =>
      this.handlePrompt(envelope, response),
    );
  }

  async start(): Promise<void> {
    await this.service.start();
  }

  get instanceId(): string {
    return this.service.instanceId;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  summary(): SessionSummary {
    const now = Date.now();
    const elapsed = Math.floor((now - this.createdAt) / 1000);
    const remaining =
      this.maxLifetimeS > 0 ? Math.max(0, this.maxLifetimeS - elapsed) : 0;
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

  private async handlePrompt(
    envelope: RequestEnvelope,
    response: PromptResponse,
  ): Promise<void> {
    if (this.disposed) throw new Error("session stopped");
    if (this.expired()) throw new Error("session expired");

    let stagedDir: string | undefined;
    let body = envelope.prompt;
    if (envelope.attachments && envelope.attachments.length > 0) {
      try {
        const staged = await stageAttachments(
          this.sessionId,
          envelope.attachments,
        );
        stagedDir = staged.dir;
        body = decorateWithAttachments(body, staged.paths);
      } catch (e) {
        throw new ProtocolError(
          `failed to stage attachments: ${(e as Error).message}`,
        );
      }
    }

    const requestId = `${this.sessionId}-${++this.requestCounter}`;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    const pending: PendingRequest = {
      requestId,
      response,
      body,
      createdAt: Date.now(),
      stagedDir,
      completion,
      resolve,
      reject,
      settled: false,
    };
    this.pendingRequests.set(requestId, pending);
    this.requestQueue.push(requestId);
    this.lastActivity = Date.now();
    this.log(
      `pi-headless: session ${this.sessionId} queued prompt ${requestId} sender=${formatSender(response.sender)}`,
    );
    void this.drain();
    return completion;
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.activeRequestId !== null) return;
    const next = this.requestQueue.shift();
    if (!next) return;
    const pending = this.pendingRequests.get(next);
    if (!pending) {
      void this.drain();
      return;
    }

    this.activeRequestId = next;
    this.lastActivity = Date.now();

    let unsubscribe: (() => void) | undefined;
    let failure: Error | undefined;
    try {
      unsubscribe = this.piSession.subscribe((ev: unknown) => {
        const delta = extractTextDelta(ev);
        if (delta !== undefined) {
          void pending.response
            .send({ type: "response", text: delta })
            .catch((e) =>
              this.log(
                `pi-headless: response publish failed for ${this.sessionId}: ${(e as Error).message}`,
              ),
            );
        }
      });
      await this.piSession.prompt(pending.body);
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e));
    } finally {
      try {
        unsubscribe?.();
      } catch {
        /* noop */
      }
      if (pending.stagedDir) {
        void cleanupStaged({ dir: pending.stagedDir, paths: [] });
      }
      this.pendingRequests.delete(next);
      if (this.activeRequestId === next) this.activeRequestId = null;
      this.lastActivity = Date.now();
      if (failure) this.reject(pending, failure);
      else this.resolve(pending);

      if (!this.disposed && this.requestQueue.length > 0) {
        setImmediate(() => void this.drain());
      }
    }
  }

  /** Returns true if this session has outlived its maxLifetime. */
  expired(now: number = Date.now()): boolean {
    if (this.maxLifetimeS <= 0) return false;
    return now - this.createdAt > this.maxLifetimeS * 1000;
  }

  /** Reject queued requests older than cutoffMs; active work is never pruned. */
  pruneStale(cutoffMs: number): number {
    let removed = 0;
    const cutoff = Date.now() - cutoffMs;
    for (const [id, pending] of this.pendingRequests) {
      if (id === this.activeRequestId || pending.createdAt >= cutoff) continue;
      this.pendingRequests.delete(id);
      const qi = this.requestQueue.indexOf(id);
      if (qi >= 0) this.requestQueue.splice(qi, 1);
      if (pending.stagedDir) {
        void cleanupStaged({ dir: pending.stagedDir, paths: [] });
      }
      this.reject(
        pending,
        new Error("prompt expired while waiting in the session queue"),
      );
      removed += 1;
    }
    return removed;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const pending = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    this.requestQueue.length = 0;
    this.activeRequestId = null;
    for (const request of pending) {
      if (request.stagedDir) {
        void cleanupStaged({ dir: request.stagedDir, paths: [] });
      }
      this.reject(
        request,
        new Error("session stopped before the prompt completed"),
      );
    }

    try {
      this.piSession.dispose();
    } catch (e) {
      this.log(
        `pi-headless: piSession.dispose() failed for ${this.sessionId}: ${(e as Error).message}`,
      );
    }

    // Let AgentService observe the rejected deferred handlers and publish
    // their error + terminator before unregistering the endpoint.
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await this.nc.flush();
    } catch {
      /* noop */
    }
    try {
      await this.service.stop();
    } catch (e) {
      this.log(
        `pi-headless: service.stop() failed for ${this.sessionId}: ${(e as Error).message}`,
      );
    }
  }

  private resolve(pending: PendingRequest): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.resolve();
  }

  private reject(pending: PendingRequest, error: Error): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.reject(error);
  }
}

/** Extract text deltas from PI's session event stream. */
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

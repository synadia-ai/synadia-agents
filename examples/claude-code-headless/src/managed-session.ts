// Per-session glue: bridges one Claude Agent SDK session to a SDK
// `ReferenceAgent` registered on the protocol-standard subject. Handles
// envelope parsing, request queueing for serial drain (the SDK's `query()`
// is one full multi-turn round-trip per call, and concurrent re-entry into
// the same logical session would interleave context), typed-chunk
// streaming, error headers, and disposal.

import type { NatsConnection } from "@nats-io/nats-core";
import type { ServiceMsg } from "@nats-io/services";
import { ReferenceAgent } from "@synadia-ai/agents/testing";
import { query, type Options, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { cleanupStaged, decorateWithAttachments, stageAttachments } from "./attachments.js";
import { responseText, statusAck } from "./chunk-encoder.js";
import { EnvelopeError, parseEnvelope, type ParsedAttachment } from "./envelope.js";
import { sessionHeartbeatSubject, sessionPromptSubject } from "./subjects.js";

export interface ManagedSessionOptions {
  readonly nc: NatsConnection;
  readonly owner: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly allowedTools: ReadonlyArray<string>;
  readonly permissionMode: PermissionMode;
  readonly maxTurns: number;
  readonly maxLifetimeS: number;
}

export interface SessionSummary {
  readonly session_id: string;
  readonly subject: string;
  readonly heartbeat_subject: string;
  readonly cwd: string;
  readonly model: string;
  readonly allowed_tools: ReadonlyArray<string>;
  readonly permission_mode: PermissionMode;
  readonly max_turns: number;
  readonly max_lifetime_s: number;
  readonly remaining_lifetime_s: number;
  readonly active_request: boolean;
  readonly queued_requests: number;
  readonly created_at: string;
  readonly last_activity: string;
  /** SDK session id, populated after the first turn finishes (used for resume). */
  readonly sdk_session_id?: string;
}

interface PendingRequest {
  readonly requestId: string;
  readonly msg: ServiceMsg;
  readonly body: string;
  readonly createdAt: number;
  readonly stagedDir: string | undefined;
}

const HEARTBEAT_INTERVAL_S = 30;

export class ManagedSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly allowedTools: ReadonlyArray<string>;
  readonly permissionMode: PermissionMode;
  readonly maxTurns: number;
  readonly maxLifetimeS: number;
  readonly createdAt: number;
  readonly subject: string;
  readonly heartbeatSubject: string;

  private readonly nc: NatsConnection;
  private readonly owner: string;
  private readonly refAgent: ReferenceAgent;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly requestQueue: string[] = [];
  private readonly activeAborts = new Set<AbortController>();
  private activeRequestId: string | null = null;
  private lastActivity: number;
  private requestCounter = 0;
  private sdkSessionId: string | undefined;
  private disposed = false;

  constructor(opts: ManagedSessionOptions) {
    this.nc = opts.nc;
    this.owner = opts.owner;
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.allowedTools = opts.allowedTools;
    this.permissionMode = opts.permissionMode;
    this.maxTurns = opts.maxTurns;
    this.maxLifetimeS = opts.maxLifetimeS;
    this.createdAt = Date.now();
    this.lastActivity = this.createdAt;
    this.subject = sessionPromptSubject(this.owner, this.sessionId);
    this.heartbeatSubject = sessionHeartbeatSubject(this.owner, this.sessionId);

    const extraMetadata: Record<string, string> = {
      spawner: "claude-code-headless",
      cwd: this.cwd,
      model: this.model,
      permission_mode: this.permissionMode,
      allowed_tools: this.allowedTools.join(","),
      max_turns: String(this.maxTurns),
      max_lifetime_s: String(this.maxLifetimeS),
    };

    this.refAgent = new ReferenceAgent({
      nc: this.nc,
      agent: "cc",
      owner: this.owner,
      name: this.sessionId,
      session: this.sessionId,
      description: `claude-code-headless session ${this.sessionId} (${this.cwd})`,
      version: "0.1.0",
      maxPayload: "1MB",
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
      cwd: this.cwd,
      model: this.model,
      allowed_tools: this.allowedTools,
      permission_mode: this.permissionMode,
      max_turns: this.maxTurns,
      max_lifetime_s: this.maxLifetimeS,
      remaining_lifetime_s: remaining,
      active_request: this.activeRequestId !== null,
      queued_requests: this.requestQueue.length,
      created_at: new Date(this.createdAt).toISOString(),
      last_activity: new Date(this.lastActivity).toISOString(),
      ...(this.sdkSessionId ? { sdk_session_id: this.sdkSessionId } : {}),
    };
  }

  // ─── Prompt path ────────────────────────────────────────────────────────────

  private async handlePrompt(msg: ServiceMsg): Promise<void> {
    if (this.disposed) {
      try {
        msg.respond("");
      } catch {
        /* connection gone */
      }
      return;
    }

    let envelope;
    try {
      envelope = parseEnvelope(msg.data);
    } catch (e) {
      if (e instanceof EnvelopeError) {
        try {
          msg.respondError(e.code, e.message);
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
    const attachments = envelope.attachments;
    if (attachments && attachments.length > 0) {
      try {
        const staged = await stageAttachments(this.sessionId, attachments as ParsedAttachment[]);
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

    const abortController = new AbortController();
    this.activeAborts.add(abortController);

    try {
      try {
        pr.msg.respond(statusAck());
      } catch {
        /* noop */
      }

      const queryOptions: Options = {
        cwd: this.cwd,
        model: this.model,
        allowedTools: [...this.allowedTools],
        permissionMode: this.permissionMode,
        maxTurns: this.maxTurns,
        abortController,
      };
      if (this.sdkSessionId) {
        queryOptions.resume = this.sdkSessionId;
      }

      const stream = query({ prompt: pr.body, options: queryOptions });
      for await (const ev of stream) {
        if (ev.type === "system" && "subtype" in ev && ev.subtype === "init") {
          this.sdkSessionId = ev.session_id;
          continue;
        }
        if (ev.type === "assistant") {
          for (const block of ev.message.content) {
            if (block.type === "text") {
              const text = (block as { text?: unknown }).text;
              if (typeof text === "string" && text.length > 0) {
                try {
                  pr.msg.respond(responseText(text));
                } catch {
                  /* noop */
                }
              }
            }
            // tool_use / thinking blocks intentionally suppressed in the spike.
            // TODO: relay tool_use as protocol §7 query chunks.
          }
          continue;
        }
        if (ev.type === "result") {
          this.sdkSessionId = ev.session_id;
          if (ev.subtype !== "success") {
            try {
              pr.msg.respondError(500, `claude-agent-sdk: ${ev.subtype}`);
            } catch {
              /* noop */
            }
          }
          break;
        }
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError" || abortController.signal.aborted) {
        // Disposal aborted us; just terminate the reply.
      } else {
        try {
          pr.msg.respondError(500, err.message || "agent error");
        } catch {
          /* noop */
        }
      }
    } finally {
      this.activeAborts.delete(abortController);
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

  // ─── Lifetime / pruning (called by ClaudeSessionManager) ───────────────────

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

    // Cancel any in-flight SDK queries so callers don't hang.
    for (const ac of this.activeAborts) {
      try {
        ac.abort();
      } catch {
        /* noop */
      }
    }
    this.activeAborts.clear();

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
        `claude-code-headless: refAgent.stop() failed for ${this.sessionId}: ${(e as Error).message}\n`,
      );
    }
  }
}

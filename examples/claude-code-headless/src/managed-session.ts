// Per-session glue: bridges one Claude Agent SDK session to a SDK
// `ReferenceAgent` registered on the protocol-standard subject. Handles
// envelope parsing, request queueing for serial drain (the SDK's `query()`
// is one full multi-turn round-trip per call, and concurrent re-entry into
// the same logical session would interleave context), typed-chunk
// streaming, error headers, tool-call observability, interactive
// permission requests via §7 query chunks, per-token streaming, cost
// tracking, and disposal.

import { createInbox } from "@nats-io/nats-core";
import type { NatsConnection } from "@nats-io/nats-core";
import type { ServiceMsg } from "@nats-io/services";
import { ReferenceAgent } from "@synadia-ai/agent-service/testing";
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

import { cleanupStaged, decorateWithAttachments, stageAttachments } from "./attachments.js";
import {
  costStatus,
  queryChunk,
  responseText,
  statusAck,
  toolResultStatus,
  toolUseStatus,
} from "./chunk-encoder.js";
import { EnvelopeError, parseEnvelope, type ParsedAttachment } from "./envelope.js";
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
  readonly model: string;
  readonly allowedTools: ReadonlyArray<string>;
  readonly permissionMode: PermissionMode;
  readonly maxTurns: number;
  readonly maxLifetimeS: number;
  /** Absolute path to the `claude` binary, forwarded to the SDK. */
  readonly claudeCodePath?: string;
}

export interface SessionSummary {
  readonly session_id: string;
  readonly subject: string;
  readonly heartbeat_subject: string;
  readonly status_subject: string;
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
  /** Cumulative USD cost across all completed turns in this session. */
  readonly total_cost_usd: number;
  /** Number of turns (SDK `query()` invocations) completed. */
  readonly turn_count: number;
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
const PERMISSION_TIMEOUT_MS = 120_000; // 2 minutes for a user to decide

export class ManagedSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly allowedTools: ReadonlyArray<string>;
  readonly permissionMode: PermissionMode;
  readonly maxTurns: number;
  readonly maxLifetimeS: number;
  readonly claudeCodePath: string | undefined;
  readonly createdAt: number;
  readonly subject: string;
  readonly heartbeatSubject: string;
  readonly statusSubject: string;

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
  private totalCostUsd = 0;
  private turnCount = 0;
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
    this.claudeCodePath = opts.claudeCodePath;
    this.createdAt = Date.now();
    this.lastActivity = this.createdAt;
    this.subject = sessionPromptSubject(this.owner, this.sessionId);
    this.heartbeatSubject = sessionHeartbeatSubject(this.owner, this.sessionId);
    this.statusSubject = sessionStatusSubject(this.owner, this.sessionId);

    const extraMetadata: Record<string, string> = {
      role: "session",
      cwd: this.cwd,
      model: this.model,
      permission_mode: this.permissionMode,
      allowed_tools: this.allowedTools.join(","),
      max_turns: String(this.maxTurns),
      max_lifetime_s: String(this.maxLifetimeS),
    };

    // `maxPayload` is intentionally omitted — `ReferenceAgent` defaults to
    // the broker's negotiated `nc.info.max_payload` (e.g. 8 MB on NGS, 1 MB
    // on a default `nats-server`), which is exactly what we want each
    // session to advertise.
    this.refAgent = new ReferenceAgent({
      nc: this.nc,
      agent: "cc-headless",
      owner: this.owner,
      name: this.sessionId,
      session: this.sessionId,
      description: `claude-code-headless session ${this.sessionId} (${this.cwd})`,
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
      total_cost_usd: this.totalCostUsd,
      turn_count: this.turnCount,
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

    // Reply subject for chunks streamed back to the caller; also where any
    // §7 query chunks emitted by canUseTool will land.
    const replySubject = pr.msg.reply ?? "";

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
        // Per-token streaming: the SDK emits stream_event partials for
        // incremental text deltas in addition to the final assistant message.
        includePartialMessages: true,
        // Permission asking: the SDK calls this when it wants to use a tool
        // that isn't auto-allowed by the current permissionMode + allowedTools.
        // We surface it as a §7 query chunk, await the caller's reply, and
        // resolve the SDK promise accordingly.
        canUseTool: this.makeCanUseTool(replySubject, abortController.signal),
      };
      if (this.sdkSessionId) {
        queryOptions.resume = this.sdkSessionId;
      }
      if (this.claudeCodePath) {
        queryOptions.pathToClaudeCodeExecutable = this.claudeCodePath;
      }

      const stream = query({ prompt: pr.body, options: queryOptions });
      for await (const ev of stream) {
        if (ev.type === "system" && "subtype" in ev && ev.subtype === "init") {
          this.sdkSessionId = ev.session_id;
          continue;
        }
        if (ev.type === "stream_event") {
          // Per-token streaming: text deltas inside content_block_delta events.
          // Other partial events (block start/stop, message_delta, etc.) we
          // intentionally drop — UI cares only about visible text and we get
          // the final blocks (incl. tool_use) via the assistant event below.
          const text = extractPartialText(ev);
          if (text && text.length > 0) {
            try {
              pr.msg.respond(responseText(text));
            } catch {
              /* noop */
            }
          }
          continue;
        }
        if (ev.type === "assistant") {
          // Surface tool_use blocks for visibility. Text was already streamed
          // via stream_event partials, so we skip text blocks here to avoid
          // duplication.
          for (const block of ev.message.content) {
            if (block.type === "tool_use") {
              const tu = block as { id: string; name: string; input: Record<string, unknown> };
              try {
                pr.msg.respond(toolUseStatus(tu.id, tu.name, tu.input));
              } catch {
                /* noop */
              }
            }
            // text blocks: already streamed via partials; intentionally skip.
          }
          continue;
        }
        if (ev.type === "user") {
          // Tool results arrive here as a synthetic user-role message whose
          // content is an array of `tool_result` blocks paired by tool_use_id.
          const userContent = (ev as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(userContent)) {
            for (const block of userContent) {
              if (block && typeof block === "object" && (block as { type?: string }).type === "tool_result") {
                const tr = block as {
                  tool_use_id: string;
                  content?: unknown;
                  is_error?: boolean;
                };
                const output = stringifyToolResultContent(tr.content);
                try {
                  pr.msg.respond(toolResultStatus(tr.tool_use_id, output, tr.is_error === true));
                } catch {
                  /* noop */
                }
              }
            }
          }
          continue;
        }
        if (ev.type === "result") {
          this.sdkSessionId = ev.session_id;
          this.turnCount += 1;
          // Cost: only success carries `total_cost_usd`. Errors may not.
          if (ev.subtype === "success") {
            const turnCost = (ev as { total_cost_usd?: number }).total_cost_usd ?? 0;
            this.totalCostUsd += turnCost;
            try {
              pr.msg.respond(costStatus(turnCost, this.totalCostUsd));
            } catch {
              /* noop */
            }
          } else {
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

  /**
   * Build a canUseTool callback bound to the active request's reply subject.
   * Each invocation emits a fresh §7 query chunk on a unique inbox, awaits a
   * single-message reply (with a 2-minute timeout), and translates the
   * caller's text reply into a PermissionResult the SDK understands.
   */
  private makeCanUseTool(
    replySubject: string,
    abortSignal: AbortSignal,
  ): CanUseTool {
    return async (toolName, input, opts): Promise<PermissionResult> => {
      // No reply subject means the caller bailed before we got here — deny.
      if (!replySubject) {
        return { behavior: "deny", message: "no active reply channel" };
      }
      const replyInbox = createInbox();
      const sub = this.nc.subscribe(replyInbox, { max: 1 });
      const promptText = buildPermissionPrompt(toolName, input, opts);
      try {
        this.nc.publish(replySubject, queryChunk(opts.toolUseID, replyInbox, promptText));
        await this.nc.flush();
      } catch (e) {
        try {
          sub.unsubscribe();
        } catch {
          /* noop */
        }
        return { behavior: "deny", message: `failed to emit query: ${(e as Error).message}` };
      }
      const timer = setTimeout(() => {
        try {
          sub.unsubscribe();
        } catch {
          /* noop */
        }
      }, PERMISSION_TIMEOUT_MS);
      const onAbort = (): void => {
        try {
          sub.unsubscribe();
        } catch {
          /* noop */
        }
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      try {
        for await (const m of sub) {
          const reply = m.string().trim();
          return interpretPermissionReply(reply, input);
        }
        // Subscription ended without a message — timeout, abort, or stream end.
        return { behavior: "deny", message: "permission request timed out" };
      } finally {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
      }
    };
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
        // Surface as an explicit timeout error so the caller's onError fires —
        // a bare terminator would look identical to a successful completion.
        try {
          pr.msg.respondError(408, "request timed out in queue");
        } catch {
          /* noop */
        }
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

    // Terminate in-flight replies so callers don't hang. Mirror the
    // pruneStale pattern: surface as a 503 error before the terminator so
    // queued-but-not-active callers see onError("session stopped") rather
    // than a misleading onDone identical to a clean completion.
    for (const pr of this.pendingRequests.values()) {
      try {
        pr.msg.respondError(503, "session stopped");
      } catch {
        /* noop */
      }
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

// ─── Pure helpers ────────────────────────────────────────────────────────────

function extractPartialText(ev: unknown): string | undefined {
  // SDK shape: { type: "stream_event", event: BetaRawMessageStreamEvent, ... }
  // Anthropic stream events: content_block_delta with delta.type === "text_delta"
  // carry { delta: { type: "text_delta", text: "..." } }.
  if (!ev || typeof ev !== "object") return undefined;
  const inner = (ev as { event?: unknown }).event;
  if (!inner || typeof inner !== "object") return undefined;
  const e = inner as { type?: unknown; delta?: unknown };
  if (e.type !== "content_block_delta") return undefined;
  const delta = e.delta;
  if (!delta || typeof delta !== "object") return undefined;
  const d = delta as { type?: unknown; text?: unknown };
  if (d.type !== "text_delta") return undefined;
  return typeof d.text === "string" ? d.text : undefined;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // tool_result.content is often an array of {type:"text", text:"..."} blocks.
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        const obj = item as { type?: unknown; text?: unknown };
        if (obj.type === "text" && typeof obj.text === "string") {
          parts.push(obj.text);
          continue;
        }
      }
      parts.push(JSON.stringify(item));
    }
    return parts.join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

function buildPermissionPrompt(
  toolName: string,
  input: Record<string, unknown>,
  opts: { title?: string; description?: string },
): string {
  // Prefer the SDK's pre-rendered title when present (e.g. "Claude wants to
  // read foo.txt"). Otherwise build a concise one from the tool name + input.
  if (opts.title && typeof opts.title === "string") {
    const lines = [opts.title];
    if (opts.description) lines.push(opts.description);
    lines.push("", `Reply 'yes' to allow or 'no' to deny.`);
    return lines.join("\n");
  }
  const inputPreview = previewInput(input);
  return [
    `Claude wants to use tool: ${toolName}`,
    inputPreview,
    "",
    "Reply 'yes' to allow or 'no' to deny.",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

function previewInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  const json = JSON.stringify(input, null, 2);
  if (json.length <= 600) return json;
  return json.slice(0, 600) + "…[truncated]";
}

const ALLOW_TOKENS = new Set(["yes", "y", "allow", "approve", "ok", "true"]);
const DENY_TOKENS = new Set(["no", "n", "deny", "reject", "cancel", "false"]);

function interpretPermissionReply(
  reply: string,
  input: Record<string, unknown>,
): PermissionResult {
  const norm = reply.toLowerCase().trim();
  // The SDK's runtime Zod validator requires `updatedInput` on allow even
  // though the TS type marks it optional — echo the original input back as
  // the no-op "use as-is" case. (canUseTool can also rewrite tool inputs
  // before they execute; we don't, but the field still has to be set.)
  if (ALLOW_TOKENS.has(norm)) return { behavior: "allow", updatedInput: input };
  if (DENY_TOKENS.has(norm)) return { behavior: "deny", message: "user denied" };
  // Treat any other text as a denial reason — preserves operator intent
  // ("not in this directory") rather than silently allowing.
  return { behavior: "deny", message: reply || "user denied (no reason given)" };
}

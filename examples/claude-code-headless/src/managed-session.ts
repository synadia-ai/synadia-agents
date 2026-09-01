// Per-session glue: bridges one Claude Agent SDK session to a production
// `AgentService` registered on the protocol-standard subject. Handles
// request queueing for serial drain (the SDK's `query()`
// is one full multi-turn round-trip per call, and concurrent re-entry into
// the same logical session would interleave context), typed-chunk
// streaming, error headers, tool-call observability, interactive
// permission requests via §7 query chunks, per-token streaming, cost
// tracking, and disposal.

import type { NatsConnection } from "@nats-io/nats-core";
import type {
  MinSenderTrust,
  RequestEnvelope,
  SenderSigner,
} from "@synadia-ai/agents";
import { AgentService, PromptResponse } from "@synadia-ai/agent-service";
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

import { cleanupStaged, decorateWithAttachments, stageAttachments } from "./attachments.js";
import { costStatus, toolResultStatus, toolUseStatus } from "./chunk-encoder.js";
import {
  sessionHeartbeatSubject,
  sessionPromptSubject,
  sessionStatusSubject,
} from "./subjects.js";
import { protocolLogger } from "./protocol-logger.js";
import { PACKAGE_VERSION } from "./version.js";

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
  /** One shared connection signer; every logical session on this connection uses it. */
  readonly signer?: SenderSigner;
  readonly minSenderTrust?: MinSenderTrust;
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
  readonly response: PromptResponse;
  readonly body: string;
  readonly createdAt: number;
  readonly stagedDir: string | undefined;
  readonly completion: Deferred;
  readonly handlerClosed: Deferred;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly settled: () => boolean;
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
  private readonly agentService: AgentService;
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

    // `maxPayload` is intentionally omitted — `AgentService` defaults to
    // the broker's negotiated `nc.info.max_payload` (e.g. 8 MB on NGS, 1 MB
    // on a default `nats-server`), which is exactly what we want each
    // session to advertise.
    this.agentService = new AgentService({
      nc: this.nc,
      agent: "cc-headless",
      owner: this.owner,
      name: this.sessionId,
      session: this.sessionId,
      description: `claude-code-headless session ${this.sessionId} (${this.cwd})`,
      version: PACKAGE_VERSION,
      attachmentsOk: true,
      heartbeatIntervalS: HEARTBEAT_INTERVAL_S,
      extraMetadata,
      minSenderTrust: opts.minSenderTrust ?? "any",
      logger: protocolLogger,
      ...(opts.signer ? { identity: { signer: opts.signer } } : {}),
    });
    this.agentService.onPrompt((envelope, response) => this.handlePrompt(envelope, response));
  }

  async start(): Promise<void> {
    await this.agentService.start();
  }

  get instanceId(): string {
    return this.agentService.instanceId;
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

  private async handlePrompt(
    envelope: RequestEnvelope,
    response: PromptResponse,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("session stopped");
    }

    // Reject prompts to a session whose lifetime ran out. The manager's
    // sweep loop disposes expired sessions on a tick; without this guard,
    // a prompt that arrives between expiry and the next sweep would be
    // served normally — accepting work the session is about to drop.
    if (this.expired()) {
      throw new Error("session expired");
    }

    let stagedDir: string | undefined;
    let body = envelope.prompt;
    const attachments = envelope.attachments;
    if (attachments && attachments.length > 0) {
      try {
        const staged = await stageAttachments(this.sessionId, attachments);
        stagedDir = staged.dir;
        body = decorateWithAttachments(body, staged.paths);
      } catch {
        throw new Error("failed to stage attachments");
      }
    }

    // Attachment staging yields to the event loop. Re-check lifecycle state
    // before publishing this handler into the queue so dispose() cannot miss
    // a request that began just before shutdown or expiry.
    if (this.disposed || this.expired()) {
      if (stagedDir) await cleanupStaged({ dir: stagedDir, paths: [] });
      throw new Error(this.disposed ? "session stopped" : "session expired");
    }

    const requestId = `${this.sessionId}-${++this.requestCounter}`;
    const completion = deferred();
    const handlerClosed = deferred();
    this.pendingRequests.set(requestId, {
      requestId,
      response,
      body,
      createdAt: Date.now(),
      stagedDir,
      completion,
      handlerClosed,
    });
    this.requestQueue.push(requestId);
    this.lastActivity = Date.now();
    void this.drain();
    try {
      await completion.promise;
    } finally {
      if (stagedDir) await cleanupStaged({ dir: stagedDir, paths: [] });
      handlerClosed.resolve();
    }
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
    if (this.expired()) {
      this.pendingRequests.delete(next);
      pr.completion.reject(new Error("session expired"));
      if (this.requestQueue.length > 0) setImmediate(() => void this.drain());
      return;
    }

    this.activeRequestId = next;
    this.lastActivity = Date.now();

    const abortController = new AbortController();
    this.activeAborts.add(abortController);

    try {
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
        canUseTool: this.makeCanUseTool(pr.response, abortController.signal),
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
            await pr.response.send(text);
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
              await pr.response.send(toolUseStatus(tu.id, tu.name, tu.input));
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
                await pr.response.send(
                  toolResultStatus(tr.tool_use_id, output, tr.is_error === true),
                );
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
            await pr.response.send(costStatus(turnCost, this.totalCostUsd));
          } else {
            throw new Error(`claude-agent-sdk: ${ev.subtype}`);
          }
          break;
        }
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError" || abortController.signal.aborted) {
        pr.completion.reject(new Error("session stopped"));
      } else {
        pr.completion.reject(new Error(`agent turn failed (${err.name || "Error"})`));
      }
    } finally {
      this.activeAborts.delete(abortController);
      this.pendingRequests.delete(next);
      this.activeRequestId = null;
      this.lastActivity = Date.now();
      if (!pr.completion.settled()) pr.completion.resolve();

      if (!this.disposed && this.requestQueue.length > 0) {
        setImmediate(() => void this.drain());
      }
    }
  }

  /**
   * Build a canUseTool callback bound to the active PromptResponse. The
   * production host SDK owns the §7 inbox, query chunk, timeout, and cleanup.
   */
  private makeCanUseTool(
    response: PromptResponse,
    abortSignal: AbortSignal,
  ): CanUseTool {
    return async (toolName, input, opts): Promise<PermissionResult> => {
      const promptText = buildPermissionPrompt(toolName, input, opts);
      try {
        const answer = await askUntilAbort(response, promptText, abortSignal);
        return interpretPermissionReply(answer, input);
      } catch {
        return { behavior: "deny", message: "permission request timed out or was cancelled" };
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
        pr.completion.reject(new Error("request timed out in queue"));
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

    const handlerClosures = Array.from(
      this.pendingRequests.values(),
      (pr) => pr.handlerClosed.promise,
    );
    for (const pr of this.pendingRequests.values()) {
      pr.completion.reject(new Error("session stopped"));
    }
    this.requestQueue.length = 0;
    await Promise.allSettled(handlerClosures);
    this.pendingRequests.clear();

    try {
      await this.agentService.stop();
    } catch (e) {
      process.stderr.write(
        `claude-code-headless: AgentService.stop() failed for ${this.sessionId} (${e instanceof Error ? e.name : "unknown error"})\n`,
      );
    }
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function deferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  let done = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  promise.catch(() => undefined);
  return {
    promise,
    resolve() {
      if (done) return;
      done = true;
      resolvePromise();
    },
    reject(error) {
      if (done) return;
      done = true;
      rejectPromise(error);
    },
    settled: () => done,
  };
}

async function askUntilAbort(
  response: PromptResponse,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw new Error("permission request cancelled");
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(new Error("permission request cancelled"));
  signal.addEventListener("abort", onAbort, { once: true });
  const asked = response.ask(prompt, { timeoutMs: PERMISSION_TIMEOUT_MS });
  asked.catch(() => undefined);
  try {
    return (await Promise.race([asked, aborted])).prompt;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

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

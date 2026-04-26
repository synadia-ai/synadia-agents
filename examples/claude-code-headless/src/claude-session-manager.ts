// Aggregate state + spawn/stop/list operations for all headless Claude Code
// sessions.
//
// Owns the Map<session_id, ManagedSession>, the lifetime-expiry loop, and
// stale-request pruning. The controller calls through to this.

import { existsSync, statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import type { NatsConnection } from "@nats-io/nats-core";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { ManagedSession, type SessionSummary } from "./managed-session.js";
import { generateSessionId, validateSessionId } from "./subjects.js";

const LIFETIME_CHECK_INTERVAL_MS = 30_000;
const STALE_PRUNE_INTERVAL_MS = 60_000;
const STALE_REQUEST_CUTOFF_MS = 30 * 60 * 1000;

const VALID_PERMISSION_MODES: ReadonlyArray<PermissionMode> = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
];

export interface SpawnSpec {
  readonly cwd: string;
  readonly session_id?: string;
  readonly model?: string;
  readonly allowed_tools?: ReadonlyArray<string>;
  readonly permission_mode?: string;
  readonly max_turns?: number;
  readonly max_lifetime_s?: number;
}

export interface SpawnDescriptor {
  readonly session_id: string;
  readonly subject: string;
  readonly heartbeat_subject: string;
  readonly cwd: string;
  readonly model: string;
  readonly allowed_tools: ReadonlyArray<string>;
  readonly permission_mode: PermissionMode;
  readonly max_turns: number;
  readonly max_lifetime_s: number;
  readonly created_at: string;
  readonly instance_id: string;
  /** Cumulative cost so far. Always 0 at spawn time; included for shape parity with summary. */
  readonly total_cost_usd: number;
  /** Number of completed turns. Always 0 at spawn time; included for shape parity. */
  readonly turn_count: number;
}

export type SpawnError =
  | { code: 400; message: string }
  | { code: 409; message: string; session_id: string };

export interface ClaudeSessionManagerOptions {
  readonly nc: NatsConnection;
  readonly owner: string;
  readonly defaultModel: string;
  readonly defaultPermissionMode: string;
  readonly defaultAllowedTools: ReadonlyArray<string>;
  readonly defaultMaxTurns: number;
  readonly defaultMaxLifetimeS: number;
  /** Absolute path to the `claude` binary; passed to the SDK as `pathToClaudeCodeExecutable`. */
  readonly claudeCodePath?: string;
  readonly logger?: (line: string) => void;
}

const defaultLogger = (line: string) => process.stderr.write(`${line}\n`);

export class ClaudeSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly creating = new Set<string>();
  private readonly options: ClaudeSessionManagerOptions;
  private readonly log: (line: string) => void;

  private lifetimeTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(options: ClaudeSessionManagerOptions) {
    this.options = options;
    this.log = options.logger ?? defaultLogger;
    // Validate default permission mode at construction time so misconfig
    // surfaces at startup, not on first spawn.
    if (!isPermissionMode(options.defaultPermissionMode)) {
      throw new Error(
        `claude-code-headless: invalid defaultPermissionMode "${options.defaultPermissionMode}" (must be one of ${VALID_PERMISSION_MODES.join(", ")})`,
      );
    }
  }

  async start(): Promise<void> {
    this.lifetimeTimer = setInterval(() => this.checkLifetimes(), LIFETIME_CHECK_INTERVAL_MS);
    this.lifetimeTimer.unref?.();
    this.pruneTimer = setInterval(() => this.pruneStale(), STALE_PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.lifetimeTimer) clearInterval(this.lifetimeTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.lifetimeTimer = null;
    this.pruneTimer = null;

    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(all.map((m) => m.dispose().catch(() => undefined)));
  }

  list(): ReadonlyArray<SessionSummary> {
    return Array.from(this.sessions.values()).map((m) => m.summary());
  }

  count(): number {
    return this.sessions.size;
  }

  async spawn(spec: SpawnSpec): Promise<SpawnDescriptor | SpawnError> {
    if (this.stopping) return { code: 400, message: "shutting down" };

    if (!spec.cwd || typeof spec.cwd !== "string") {
      return { code: 400, message: "cwd is required" };
    }
    const absCwd = pathResolve(spec.cwd);
    if (!existsSync(absCwd) || !statSync(absCwd).isDirectory()) {
      return { code: 400, message: `cwd not found or not a directory: ${absCwd}` };
    }

    let sessionId: string;
    if (spec.session_id !== undefined) {
      if (typeof spec.session_id !== "string" || spec.session_id.length === 0) {
        return { code: 400, message: "session_id must be a non-empty string" };
      }
      const v = validateSessionId(spec.session_id);
      if (!v.ok) {
        return {
          code: 400,
          message: v.suggestion
            ? `session_id must match [a-z0-9_-]+ (suggested: ${v.suggestion})`
            : "session_id is empty after sanitization",
        };
      }
      sessionId = v.sessionId;
    } else {
      sessionId = generateSessionId();
      while (this.sessions.has(sessionId) || this.creating.has(sessionId)) {
        sessionId = generateSessionId();
      }
    }

    if (this.sessions.has(sessionId) || this.creating.has(sessionId)) {
      return { code: 409, session_id: sessionId, message: "session already exists" };
    }

    const model = spec.model ?? this.options.defaultModel;
    if (typeof model !== "string" || model.length === 0) {
      return { code: 400, message: "model must be a non-empty string" };
    }

    let allowedTools: ReadonlyArray<string>;
    if (spec.allowed_tools !== undefined) {
      if (!Array.isArray(spec.allowed_tools)) {
        return { code: 400, message: "allowed_tools must be an array of strings" };
      }
      for (const t of spec.allowed_tools) {
        if (typeof t !== "string" || t.length === 0) {
          return { code: 400, message: "allowed_tools entries must be non-empty strings" };
        }
      }
      allowedTools = [...spec.allowed_tools];
    } else {
      allowedTools = [...this.options.defaultAllowedTools];
    }

    const permissionModeRaw = spec.permission_mode ?? this.options.defaultPermissionMode;
    if (!isPermissionMode(permissionModeRaw)) {
      return {
        code: 400,
        message: `invalid permission_mode: ${permissionModeRaw} (must be one of ${VALID_PERMISSION_MODES.join(", ")})`,
      };
    }
    const permissionMode: PermissionMode = permissionModeRaw;

    const maxTurns = Number(spec.max_turns ?? this.options.defaultMaxTurns);
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
      return { code: 400, message: "max_turns must be a positive integer" };
    }

    const maxLifetimeS = Number(spec.max_lifetime_s ?? this.options.defaultMaxLifetimeS);
    if (!Number.isFinite(maxLifetimeS) || maxLifetimeS < 0) {
      return { code: 400, message: "max_lifetime_s must be a non-negative number" };
    }

    this.creating.add(sessionId);

    const managed = new ManagedSession({
      nc: this.options.nc,
      owner: this.options.owner,
      sessionId,
      cwd: absCwd,
      model,
      allowedTools,
      permissionMode,
      maxTurns,
      maxLifetimeS,
      ...(this.options.claudeCodePath ? { claudeCodePath: this.options.claudeCodePath } : {}),
    });

    try {
      await managed.start();
    } catch (e) {
      this.creating.delete(sessionId);
      return {
        code: 400,
        message: `failed to register session agent: ${(e as Error).message}`,
      };
    }

    this.sessions.set(sessionId, managed);
    this.creating.delete(sessionId);
    this.log(`claude-code-headless: spawned ${sessionId} (cwd=${absCwd}, model=${model})`);

    return {
      session_id: sessionId,
      subject: managed.subject,
      heartbeat_subject: managed.heartbeatSubject,
      cwd: managed.cwd,
      model: managed.model,
      allowed_tools: managed.allowedTools,
      permission_mode: managed.permissionMode,
      max_turns: managed.maxTurns,
      max_lifetime_s: managed.maxLifetimeS,
      created_at: new Date(managed.createdAt).toISOString(),
      instance_id: managed.instanceId,
      total_cost_usd: 0,
      turn_count: 0,
    };
  }

  async stopOne(
    sessionId: string,
  ): Promise<{ ok: true; session_id: string } | { code: 404; message: string }> {
    const m = this.sessions.get(sessionId);
    if (!m) return { code: 404, message: `no such session: ${sessionId}` };
    this.sessions.delete(sessionId);
    await m.dispose();
    this.log(`claude-code-headless: stopped ${sessionId}`);
    return { ok: true, session_id: sessionId };
  }

  // ─── Internal: lifetime + pruning ──────────────────────────────────────────

  private checkLifetimes(): void {
    if (this.stopping) return;
    const now = Date.now();
    for (const [sid, m] of this.sessions) {
      if (m.expired(now)) {
        this.sessions.delete(sid);
        this.log(`claude-code-headless: session ${sid} expired`);
        void m.dispose();
      }
    }
  }

  private pruneStale(): void {
    if (this.stopping) return;
    for (const m of this.sessions.values()) {
      m.pruneStale(STALE_REQUEST_CUTOFF_MS);
    }
  }
}

function isPermissionMode(value: string): value is PermissionMode {
  return (VALID_PERMISSION_MODES as ReadonlyArray<string>).includes(value);
}

// Aggregate state + spawn/stop/list operations for all headless PI sessions.
//
// Owns the Map<session_id, ManagedSession>, the lifetime-expiry loop, and
// stale-request pruning. The controller calls through to this.

import { existsSync, statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import type { NatsConnection } from "@nats-io/nats-core";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

import { ManagedSession, type SessionSummary } from "./managed-session.js";
import { generateSessionId, validateSessionId } from "./subjects.js";

const LIFETIME_CHECK_INTERVAL_MS = 30_000;
const STALE_PRUNE_INTERVAL_MS = 60_000;
const STALE_REQUEST_CUTOFF_MS = 30 * 60 * 1000;

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

export interface SpawnSpec {
  readonly cwd: string;
  readonly session_id?: string;
  readonly model?: string;
  readonly thinking_level?: string;
  readonly max_lifetime_s?: number;
}

export interface SpawnDescriptor {
  readonly session_id: string;
  readonly subject: string;
  readonly heartbeat_subject: string;
  readonly cwd: string;
  readonly model: string | undefined;
  readonly thinking_level: string | undefined;
  readonly max_lifetime_s: number;
  readonly created_at: string;
  readonly instance_id: string;
}

export type SpawnError =
  | { code: 400; message: string }
  | { code: 409; message: string; session_id: string };

export interface PiSessionManagerOptions {
  readonly nc: NatsConnection;
  readonly owner: string;
  readonly defaultModel?: string;
  readonly defaultThinkingLevel?: string;
  readonly defaultMaxLifetimeS: number;
  readonly logger?: (line: string) => void;
}

const defaultLogger = (line: string) => process.stderr.write(`${line}\n`);

export class PiSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly creating = new Set<string>();
  private readonly options: PiSessionManagerOptions;
  private readonly log: (line: string) => void;

  private authStorage: AuthStorage | null = null;
  private modelRegistry: ModelRegistry | null = null;
  private lifetimeTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(options: PiSessionManagerOptions) {
    this.options = options;
    this.log = options.logger ?? defaultLogger;
  }

  async start(): Promise<void> {
    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);

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
    if (!this.authStorage || !this.modelRegistry) {
      return { code: 400, message: "manager not started" };
    }

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

    const modelSpec = spec.model ?? this.options.defaultModel;
    const resolvedModel = this.resolveModel(modelSpec);
    if (modelSpec && !resolvedModel) {
      return { code: 400, message: `unknown model: ${modelSpec}` };
    }

    const thinkingLevelRaw = spec.thinking_level ?? this.options.defaultThinkingLevel;
    let thinkingLevel: ThinkingLevel | undefined;
    if (thinkingLevelRaw !== undefined && thinkingLevelRaw !== "") {
      if (!(VALID_THINKING_LEVELS as readonly string[]).includes(thinkingLevelRaw)) {
        return {
          code: 400,
          message: `invalid thinking_level: ${thinkingLevelRaw} (must be one of ${VALID_THINKING_LEVELS.join(", ")})`,
        };
      }
      thinkingLevel = thinkingLevelRaw as ThinkingLevel;
    }

    const maxLifetimeS = Number(spec.max_lifetime_s ?? this.options.defaultMaxLifetimeS);
    if (!Number.isFinite(maxLifetimeS) || maxLifetimeS < 0) {
      return { code: 400, message: "max_lifetime_s must be a non-negative number" };
    }

    this.creating.add(sessionId);
    let piSession: AgentSession;
    try {
      const created = await createAgentSession({
        cwd: absCwd,
        sessionManager: SessionManager.inMemory(),
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        model: resolvedModel?.model,
        thinkingLevel,
      });
      piSession = created.session;
    } catch (e) {
      this.creating.delete(sessionId);
      return { code: 400, message: `failed to create PI session: ${(e as Error).message}` };
    }

    const managed = new ManagedSession({
      nc: this.options.nc,
      owner: this.options.owner,
      sessionId,
      cwd: absCwd,
      model: resolvedModel?.label,
      thinkingLevel,
      maxLifetimeS,
      piSession,
    });

    try {
      await managed.start();
    } catch (e) {
      this.creating.delete(sessionId);
      try {
        piSession.dispose();
      } catch {
        /* noop */
      }
      return {
        code: 400,
        message: `failed to register session agent: ${(e as Error).message}`,
      };
    }

    this.sessions.set(sessionId, managed);
    this.creating.delete(sessionId);
    this.log(`pi-headless: spawned ${sessionId} (cwd=${absCwd})`);

    return {
      session_id: sessionId,
      subject: managed.subject,
      heartbeat_subject: managed.heartbeatSubject,
      cwd: managed.cwd,
      model: managed.model,
      thinking_level: managed.thinkingLevel,
      max_lifetime_s: managed.maxLifetimeS,
      created_at: new Date(managed.createdAt).toISOString(),
      instance_id: managed.instanceId,
    };
  }

  async stopOne(
    sessionId: string,
  ): Promise<{ ok: true; session_id: string } | { code: 404; message: string }> {
    const m = this.sessions.get(sessionId);
    if (!m) return { code: 404, message: `no such session: ${sessionId}` };
    this.sessions.delete(sessionId);
    await m.dispose();
    this.log(`pi-headless: stopped ${sessionId}`);
    return { ok: true, session_id: sessionId };
  }

  // ─── Internal: lifetime + pruning ──────────────────────────────────────────

  private resolveModel(
    modelSpec: string | undefined,
  ): { model: Model<Api>; label: string } | undefined {
    if (!modelSpec || !this.modelRegistry) return undefined;
    const slash = modelSpec.indexOf("/");
    if (slash < 0) return undefined;
    const provider = modelSpec.slice(0, slash);
    const id = modelSpec.slice(slash + 1);
    const found = this.modelRegistry.find(provider, id);
    if (!found) return undefined;
    return { model: found, label: `${provider}/${id}` };
  }

  private checkLifetimes(): void {
    if (this.stopping) return;
    const now = Date.now();
    for (const [sid, m] of this.sessions) {
      if (m.expired(now)) {
        this.sessions.delete(sid);
        this.log(`pi-headless: session ${sid} expired`);
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

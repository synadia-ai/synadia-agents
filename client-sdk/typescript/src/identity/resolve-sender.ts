// Reverse lookup: from an agent ID to the agent that registered it (spec
// "Reverse lookup: from agent ID to agent").
//
//   1. Enumerate instances through `$SRV.INFO.agents` and index them by
//      `(account, user_nkey)` — i.e. by `AgentInfo.identity`.
//   2. Verify `id_sig` on each candidate against its own `prompt` endpoint
//      subject; drop failures (`buildAgentInfo` already runs that
//      verification per record — `AgentInfo.idSigVerified`).
//   3. Return the instance's `AgentInfo`, or `undefined` when no verified
//      instance claims the key: the sender is then not a reachable agent.
//
// Enumeration is scatter-gather over every instance, so `SenderResolver`
// caches the index for a short TTL (default 10 s) instead of enumerating
// per message; concurrent callers share one in-flight enumeration.
// Discovery is account-local: a lookup only sees agents whose `$SRV`
// subjects the connection's account can reach. The lookup **identifies**;
// it never authorizes. Same shape as the Python SDK's `SenderResolver`.

import type { NatsConnection, RequestManyOptions } from "@nats-io/nats-core";
import type { AgentInfo } from "../discovery/agent-info.js";
import {
  DEFAULT_DISCOVER_MAX_WAIT_MS,
  DEFAULT_DISCOVER_STALL_MS,
  enumerateAgentInfos,
} from "../discovery/srv-ping.js";
import { IdentityError } from "../errors.js";
import { parseAgentId, type AgentId } from "./agent-id.js";

/** Default TTL of the `$SRV.INFO` index (spec: suggested, not required). */
export const DEFAULT_RESOLVE_TTL_MS = 10_000;

export interface SenderResolverOptions {
  /** How long one enumeration is reused, in milliseconds. `0` enumerates on every call. Default 10 000. */
  readonly ttlMs?: number;
  /**
   * When set, each enumeration waits exactly this long (`strategy: "timer"`),
   * like `Agents.discover({ timeoutMs })`. Otherwise the stall strategy
   * below applies.
   */
  readonly timeoutMs?: number;
  /** Stall window of the default strategy. Default {@link DEFAULT_DISCOVER_STALL_MS}. */
  readonly stallMs?: number;
  /** Absolute cap of the default strategy. Default {@link DEFAULT_DISCOVER_MAX_WAIT_MS}. */
  readonly maxWaitMs?: number;
}

/** Validate a TTL option: a finite number of milliseconds ≥ 0. */
export function normalizeResolveTtlMs(ttlMs: number | undefined): number {
  if (ttlMs === undefined) return DEFAULT_RESOLVE_TTL_MS;
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new IdentityError("resolveTtlMs must be a finite number of milliseconds >= 0");
  }
  return ttlMs;
}

/** A TTL-cached `$SRV.INFO.agents` index keyed by verified agent ID. */
export class SenderResolver {
  readonly #nc: NatsConnection;
  readonly #ttlMs: number;
  readonly #requestOpts: RequestManyOptions;
  #index: ReadonlyMap<AgentId, ReadonlyArray<AgentInfo>> = new Map();
  #builtAt: number | null = null;
  #inflight: Promise<void> | null = null;

  constructor(nc: NatsConnection, opts: SenderResolverOptions = {}) {
    this.#nc = nc;
    this.#ttlMs = normalizeResolveTtlMs(opts.ttlMs);
    this.#requestOpts =
      opts.timeoutMs !== undefined
        ? { strategy: "timer", maxWait: opts.timeoutMs }
        : {
            strategy: "stall",
            maxWait: opts.maxWaitMs ?? DEFAULT_DISCOVER_MAX_WAIT_MS,
            stall: opts.stallMs ?? DEFAULT_DISCOVER_STALL_MS,
          };
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Drop the cached index; the next `resolve()` enumerates again. */
  invalidate(): void {
    this.#index = new Map();
    this.#builtAt = null;
  }

  /**
   * The verified instance registered under `id`, or `undefined`. Several
   * instances of one logical agent share one user and therefore one
   * agent ID; the first one the index holds is returned. A text form is
   * parsed (`InvalidAgentIdError` on a malformed one). Rejects when the
   * enumeration itself fails (connection closed, …); the previous index,
   * if any, is kept.
   */
  async resolve(id: AgentId | string): Promise<AgentInfo | undefined> {
    const key = parseAgentId(id);
    if (this.#builtAt === null || Date.now() - this.#builtAt >= this.#ttlMs) {
      await this.#rebuild();
    }
    return this.#index.get(key)?.[0];
  }

  // One enumeration shared by every caller that finds it in flight; a
  // settled promise (fulfilled or rejected) is dropped so the next call
  // starts afresh — a rejection never sticks.
  #rebuild(): Promise<void> {
    if (!this.#inflight) {
      const p = this.#enumerate().finally(() => {
        if (this.#inflight === p) this.#inflight = null;
      });
      this.#inflight = p;
    }
    return this.#inflight;
  }

  async #enumerate(): Promise<void> {
    const infos = await enumerateAgentInfos(this.#nc, this.#requestOpts);
    const index = new Map<AgentId, AgentInfo[]>();
    for (const info of infos) {
      if (info.identity !== undefined && info.idSigVerified) {
        const list = index.get(info.identity);
        if (list) list.push(info);
        else index.set(info.identity, [info]);
      }
    }
    this.#index = index;
    this.#builtAt = Date.now();
  }
}

/** One uncached reverse lookup (see {@link SenderResolver} for the cached form). */
export function resolveSender(
  nc: NatsConnection,
  id: AgentId | string,
  opts: Omit<SenderResolverOptions, "ttlMs"> = {},
): Promise<AgentInfo | undefined> {
  return new SenderResolver(nc, { ...opts, ttlMs: 0 }).resolve(id);
}

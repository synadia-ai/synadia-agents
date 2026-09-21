// `Agents` — owner of the heartbeat wildcard subscription and the entry
// point for discovery. Orchestrates subscribe-before-discover per §8.5
// and returns live `Agent` handles.
//
// Construct with a pre-opened `NatsConnection`:
//
//   import { connect } from "@nats-io/transport-node";
//   import { Agents } from "@synadia-ai/agents";
//
//   const nc = await connect({ servers: "nats://localhost:4222" });
//   const agents = new Agents({ nc });
//   const found = await agents.discover({ timeoutMs: 2_000 });
//   for await (const msg of await found[0]!.prompt("hi")) { ... }
//
// The caller owns `nc`. `agents.close()` tears down SDK-owned state only;
// closing the underlying connection is the caller's responsibility.
//
// Sender identity (extension): pass `identity: { signer, name }` to sign
// every `prompt` / `status` request; pass `identity: {}` explicitly for an
// unsigned claim. Omitting `identity` performs no automatic lookup and sends
// no header. `selfId()` is the connection's own agent ID; `signSender` /
// `publishSigned` / `requestSigned` sign arbitrary publishes (JetStream
// included); `resolveSender(id)` is the reverse lookup (agent ID → the
// agent that registered it, `id_sig` verified, TTL-cached).
//
// Prompt interceptors: `interceptors: [...]` runs each one before every
// prompt an `Agent` from this client publishes (see `prompt/interceptor.ts`).

import type { Msg, NatsConnection } from "@nats-io/nats-core";
import type { Agent } from "./agent.js";
import type { AgentInfo } from "./discovery/agent-info.js";
import {
  discoverAgents,
  lookupAgentInstance,
  pingInstance,
  type DiscoverOptions,
} from "./discovery/srv-ping.js";
import { HeartbeatTracker, type Liveness } from "./heartbeat/tracker.js";
import { type HeartbeatPayload } from "./heartbeat/payload.js";
import type { AgentId } from "./identity/agent-id.js";
import { IdentityContext, type IdentityOptions } from "./identity/context.js";
import { SenderResolver } from "./identity/resolve-sender.js";
import { refreshSelfId, selfId } from "./identity/self-id.js";
import { serializeSenderHeader } from "./identity/sender-header.js";
import {
  NATS_MSG_ID_HEADER,
  signedPublishHeaders,
  signedSenderHeader,
  toBytes,
  type SignedPublishOptions,
} from "./identity/signed-publish.js";
import { type Logger, SILENT_LOGGER } from "./internal/logger.js";
import type { PromptInterceptor } from "./prompt/interceptor.js";

/** Default per-stream inactivity timeout (§6.6) — 60 seconds. */
export const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 60_000;

/** Default `requestSigned()` timeout — 2 seconds. */
export const DEFAULT_REQUEST_SIGNED_TIMEOUT_MS = 2_000;

export { NATS_MSG_ID_HEADER, type SignedPublishOptions };

export interface AgentsOptions {
  /** A pre-connected `NatsConnection`. Caller retains ownership. */
  readonly nc: NatsConnection;
  /** Default per-stream inactivity timeout in milliseconds. Default: 60_000. */
  readonly streamInactivityTimeoutMs?: number;
  /** Pluggable logger. Default: silent. */
  readonly logger?: Logger;
  /**
   * Sender-identity configuration. Omit for no lookup/header; pass `{}`
   * explicitly for an unsigned claim, or provide a signer.
   */
  readonly identity?: IdentityOptions;
  /**
   * TTL of the `$SRV.INFO.agents` index behind {@link Agents.resolveSender},
   * in milliseconds; `0` enumerates on every call. Default 10 000.
   */
  readonly resolveTtlMs?: number;
  /**
   * Prompt interceptors, run in order before every prompt an `Agent` from
   * this client publishes — each may publish signed messages of its own and
   * add envelope fields and headers. Default: none, and prompts are exactly
   * what the protocol sends.
   */
  readonly interceptors?: ReadonlyArray<PromptInterceptor>;
}

export interface SignedRequestOptions extends SignedPublishOptions {
  /** Request timeout in milliseconds. Default {@link DEFAULT_REQUEST_SIGNED_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

export class Agents {
  readonly #nc: NatsConnection;
  readonly #tracker: HeartbeatTracker;
  readonly #logger: Logger;
  readonly #streamInactivityTimeoutMs: number;
  readonly #identity: IdentityContext | undefined;
  readonly #interceptors: ReadonlyArray<PromptInterceptor>;
  readonly #resolver: SenderResolver;
  readonly #closeController = new AbortController();
  #closed = false;

  constructor(options: AgentsOptions) {
    this.#nc = options.nc;
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#streamInactivityTimeoutMs =
      options.streamInactivityTimeoutMs ?? DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS;
    // Omission is meaningful: no automatic lookup and no sender header.
    // An explicit empty object opts into an unsigned claim.
    this.#identity =
      options.identity !== undefined
        ? new IdentityContext(options.nc, options.identity)
        : undefined;
    // Copied: a caller mutating its array afterwards changes nothing here.
    this.#interceptors = Object.freeze([...(options.interceptors ?? [])]);
    // Validates `resolveTtlMs` up front (throws `IdentityError`).
    this.#resolver = new SenderResolver(
      options.nc,
      options.resolveTtlMs !== undefined ? { ttlMs: options.resolveTtlMs } : {},
    );
    this.#tracker = new HeartbeatTracker(options.nc, this.#logger);
  }

  /** The underlying NATS connection. */
  get connection(): NatsConnection {
    return this.#nc;
  }

  /** Default per-stream inactivity timeout applied to every `Agent.prompt()`. */
  get streamInactivityTimeoutMs(): number {
    return this.#streamInactivityTimeoutMs;
  }

  /** The prompt interceptors every `Agent` from this client runs, in order. */
  get interceptors(): ReadonlyArray<PromptInterceptor> {
    return this.#interceptors;
  }

  /**
   * Abort signal that fires when `close()` is called. Callers that construct
   * `Agent` instances outside of `discover()` (e.g. materialising one from a
   * heartbeat + `$SRV.INFO.agents.<id>` lookup) SHOULD pass this to the
   * `Agent` constructor so in-flight streams on those handles are aborted
   * when the `Agents` client is torn down, matching what `discover()` does.
   */
  get closeSignal(): AbortSignal {
    return this.#closeController.signal;
  }

  /**
   * Discover protocol-compliant agents reachable on the NATS connection.
   * Returns a live `Agent[]` — each entry is directly callable via `.prompt()`.
   *
   * The first call to `discover()` lazily starts the heartbeat wildcard
   * subscription BEFORE publishing `$SRV.PING`, enforcing §8.5 automatically.
   * With an explicit identity option that can send a signed or unsigned
   * claim, it also *starts* the connection's identity lookup
   * (fire-and-forget) so the first `prompt()` usually finds it memoised.
   * With identity omitted, or with unsigned claims explicitly disabled and
   * no signer, discovery performs no identity work.
   *
   * Two instances of the same logical agent (same `(agent, owner, name)`)
   * show up as separate entries with distinct `instanceId`s; callers who
   * want one-per-logical-agent can group with `Map.groupBy`.
   */
  async discover(opts: DiscoverOptions = {}): Promise<Agent[]> {
    this.#ensureOpen();
    this.#identity?.kickoff();
    if (!this.#tracker.isStarted) {
      // tracker.start() flushes internally so the SUB is at the server before
      // we send $SRV.PING (§8.5 subscribe-before-discover).
      await this.#tracker.start();
    }
    return discoverAgents(
      this.#nc,
      this.#streamInactivityTimeoutMs,
      this.#closeController.signal,
      opts,
      this.#identity,
      this.#interceptors,
      this.#logger,
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
   * beforehand (and await it) if you need to guarantee the subscription is
   * live before a specific moment.
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
   * Targeted `$SRV.INFO.agents.<instanceId>` lookup. Returns a constructed
   * {@link Agent} for an already-known instance id, or `null` if the
   * instance doesn't reply within the timeout / replies with malformed
   * metadata. The returned `Agent` shares this client's connection and
   * close signal, so closing the `Agents` client cancels in-flight streams
   * on the looked-up handle too.
   *
   * Use this when you already have an `instance_id` (e.g. from a heartbeat
   * payload) and want to materialise an `Agent` without re-running a
   * full discovery scan.
   */
  async lookupInstance(
    instanceId: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<Agent | null> {
    this.#ensureOpen();
    return lookupAgentInstance(
      this.#nc,
      instanceId,
      this.#streamInactivityTimeoutMs,
      this.#closeController.signal,
      opts,
      this.#identity,
      this.#interceptors,
      this.#logger,
    );
  }

  // ---------------------------------------------------------------------
  // Sender identity
  // ---------------------------------------------------------------------

  /**
   * The connection's own agent ID (`{account}.{user}`), learned from
   * `$SYS.REQ.USER.INFO` and cached per connection and identity source. A
   * credentials JWT is compared with the live user/account, never used as a
   * substitute for binding. Rejects with {@link NoIdentityError}
   * (no NKEY user — the message names the fix), {@link IdentityUnavailableError}
   * (no answer / permission violation), or {@link IdentityMismatchError}
   * (a configured signer represents a different user/account). Failures are retried
   * after 30 s; `refreshSelfId()` retries at once.
   */
  selfId(): Promise<AgentId> {
    this.#ensureOpen();
    return this.#identity?.selfId() ?? selfId(this.#nc);
  }

  /** Force a fresh identity lookup, discarding the memoised answer. */
  refreshSelfId(): Promise<AgentId> {
    this.#ensureOpen();
    return this.#identity?.refresh() ?? refreshSelfId(this.#nc);
  }

  /**
   * Build a complete `Agent-Sender` header *value* for a publish of
   * `payload` to `subject` — the SDK supplies id, `ts` and a fresh nonce
   * (or `opts.nonce`, see {@link SignedPublishOptions.nonce}). Pass the
   * exact subject and payload you will publish; set `opts.sub` only behind
   * a rename by your own account. Works for any publish, JetStream
   * included (`headers.set("Agent-Sender", value)`).
   *
   * Rejects with {@link SenderSignatureRequiredError} when no signer is
   * configured, with `IdentityError` for a malformed `opts.nonce`, else
   * with the `selfId()` error when the identity is unavailable.
   */
  async signSender(
    subject: string,
    payload: Uint8Array | string,
    opts: Pick<SignedPublishOptions, "sub" | "nonce"> = {},
  ): Promise<string> {
    this.#ensureOpen();
    return serializeSenderHeader(
      await signedSenderHeader(this.#identity, subject, toBytes(payload), opts),
    );
  }

  /**
   * Sign and publish in one step (core `nc.publish`). Sets
   * `Nats-Msg-Id` to the nonce so a JetStream stream's de-duplication
   * window helps consumers. Same error rules as {@link signSender}.
   */
  async publishSigned(
    subject: string,
    payload: Uint8Array | string,
    opts: SignedPublishOptions = {},
  ): Promise<void> {
    this.#ensureOpen();
    const bytes = toBytes(payload);
    const hdrs = await signedPublishHeaders(this.#identity, subject, bytes, opts);
    this.#nc.publish(subject, bytes, { headers: hdrs });
  }

  /**
   * Sign and send a **single-reply** request (`nc.request`) — for
   * services that answer once. Prompt streams go through
   * `Agent.prompt()`. Same error rules as {@link signSender}.
   */
  async requestSigned(
    subject: string,
    payload: Uint8Array | string,
    opts: SignedRequestOptions = {},
  ): Promise<Msg> {
    this.#ensureOpen();
    const bytes = toBytes(payload);
    const hdrs = await signedPublishHeaders(this.#identity, subject, bytes, opts);
    return this.#nc.request(subject, bytes, {
      timeout: opts.timeoutMs ?? DEFAULT_REQUEST_SIGNED_TIMEOUT_MS,
      headers: hdrs,
    });
  }

  /**
   * Reverse lookup (spec "Reverse lookup: from agent ID to agent"): the
   * `AgentInfo` of the instance that registered `id` with a verifying
   * `id_sig`, or `undefined` when no verified instance claims the key —
   * the sender is then not a reachable agent (a human user, a plain
   * service, an agent that is offline). Enumerates `$SRV.INFO.agents`
   * and caches the index for `resolveTtlMs` (default 10 s); discovery is
   * account-local. Identifies, never authorizes.
   */
  resolveSender(id: AgentId | string): Promise<AgentInfo | undefined> {
    this.#ensureOpen();
    return this.#resolver.resolve(id);
  }

  /**
   * Close the SDK-owned state. Cancels all in-flight prompt streams (they
   * throw AbortError from the iterator) and unsubscribes the heartbeat
   * wildcard. The underlying `NatsConnection` is untouched — the caller
   * who opened it is responsible for closing it.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeController.abort(new Error("@synadia-ai/agents: Agents is closed"));
    await this.#tracker.stop();
  }

  /** True if `close()` has been called. */
  get isClosed(): boolean {
    return this.#closed;
  }

  #ensureOpen(): void {
    if (this.#closed) {
      throw new Error("@synadia-ai/agents: Agents is closed");
    }
  }
}

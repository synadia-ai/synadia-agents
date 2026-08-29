// A spec-compliant reference agent for protocol v0.3.
//
// Faithfully implements the §12 agent checklist:
//   - Registers as `agents` (spec §3.1).
//   - Declares `metadata.agent`, `metadata.owner`, `metadata.protocol_version`,
//     and `metadata.session` when session-aware (§3.2).
//   - Registers a `prompt` endpoint with queue group `"agents"` (§3.3) at
//     `agents.prompt.<agent>.<owner>.<name>` (§2 v0.3) with metadata
//     `max_payload` / `attachments_ok` (§2.1).
//   - Registers a `status` endpoint at `agents.status.<agent>.<owner>.<name>`
//     (§8.7 (v0.3)) that replies with a freshly-built §8.3 heartbeat payload.
//   - Publishes heartbeats at `agents.hb.<agent>.<owner>.<name>` with all
//     §8.3 fields including `instance_id` (from the service id).
//   - Emits an empty-body no-headers terminator after each prompt
//     (default handler).
//   - Sender identity (extension): registers `user_nkey` / `account` /
//     `id_sig` when the connection has an identity (and a signer), always
//     advertises `min_sender_trust` on `prompt`, classifies every prompt
//     (400 / 401 / 403 / 500 before the handler runs) and hands the
//     classified sender to the handler as its second argument; `status`
//     is classified and logged, never rejected.
//
// Kept intentionally permissive — the `promptHandler` callback receives
// the raw `ServiceMsg` so tests can assert on malformed inputs, drop
// chunks, emit unknown shapes, etc. Production agents use
// `AgentService` (`@synadia-ai/agents/service`), which validates the
// envelope, manages keep-alive, and translates handler exceptions to
// 500s. Exported via the `@synadia-ai/agents/testing` subpath.

import type { NatsConnection } from "@nats-io/nats-core";
import { Svcm, type Service, type ServiceMsg } from "@nats-io/services";
import {
  agentIdAccount,
  agentIdUser,
  AgentSubject,
  formatHumanBytes,
  formatSender,
  IDENTITY_METADATA_KEYS,
  IdentityMismatchError,
  MIN_SENDER_TRUST_KEY,
  normalizeAccountTokenPosition,
  parseHumanBytes,
  PROMPT_ENDPOINT_NAME,
  PROMPT_QUEUE_GROUP,
  SDK_PROTOCOL_VERSION,
  selfId,
  SERVICE_NAME,
  signAgentId,
  SILENT_LOGGER,
  STATUS_ENDPOINT_NAME,
  STATUS_QUEUE_GROUP,
  type AgentId,
  type Logger,
  type MinSenderTrust,
  type SenderInfo,
  type SenderSigner,
} from "@synadia-ai/agents";

import { buildHeartbeatPayload, encodeHeartbeatPayload } from "../heartbeat/payload.js";
import {
  DEFAULT_MIN_SENDER_TRUST,
  DEFAULT_REPLAY_WINDOW_MS,
  SenderGate,
  type AcceptSenderHook,
} from "../identity/classify.js";

/**
 * Prompt handler: the raw `ServiceMsg` plus the classified sender
 * (`undefined` when the request carried no `Agent-Sender`).
 */
export type ReferenceAgentPromptHandler = (
  msg: ServiceMsg,
  sender: SenderInfo | undefined,
) => void | Promise<void>;

export interface ReferenceAgentOptions {
  /** Active NATS connection. */
  readonly nc: NatsConnection;
  /** `metadata.agent` — canonical harness identifier (e.g. `"claude-code"`). */
  readonly agent: string;
  /** `metadata.owner` — operator / account. */
  readonly owner: string;
  /** Instance name — 5th subject token (§2 v0.3). */
  readonly name: string;
  /** `metadata.session` — set for session-aware harnesses (§5.6). */
  readonly session?: string;
  /** Human-readable service description. */
  readonly description?: string;
  /** Harness semver (`service.version`). Default: `"0.0.1"`. */
  readonly version?: string;
  /**
   * Endpoint metadata `max_payload`. Defaults to the broker's
   * negotiated `nc.info.max_payload` (e.g. 8 MB on NGS, 1 MB on a
   * default `nats-server`); falls back to `"1MB"` only if `nc.info`
   * isn't populated. An explicit value is honored verbatim unless it
   * exceeds the broker's limit, in which case it's clamped down with
   * a `console.warn`.
   */
  readonly maxPayload?: string;
  /** Endpoint metadata `attachments_ok`. Default: `true`. */
  readonly attachmentsOk?: boolean;
  /** Heartbeat cadence in seconds (§8.2). Default: `1` (test-friendly). */
  readonly heartbeatIntervalS?: number;
  /** Custom prompt handler. Defaults to emitting only the empty terminator. */
  readonly promptHandler?: ReferenceAgentPromptHandler;
  /** Extra metadata keys merged into the service metadata (forward-compat). */
  readonly extraMetadata?: Readonly<Record<string, string>>;
  /** Sender-identity: the agent's own signer (registers `id_sig`). */
  readonly identity?: { readonly signer?: SenderSigner };
  /** `min_sender_trust` on the prompt endpoint. Default `"any"`; always emitted. */
  readonly minSenderTrust?: MinSenderTrust;
  /** Replay window in milliseconds. Default 30 000. */
  readonly replayWindowMs?: number;
  /** 1-based `account_token_position` of the export this agent sits behind. */
  readonly accountTokenPosition?: number;
  /** Acceptance hook — see `AgentServiceOptions.acceptSender`. */
  readonly acceptSender?: AcceptSenderHook;
  /** Logger for classification outcomes. Default: silent. */
  readonly logger?: Logger;
}

const DEFAULT_MAX_PAYLOAD = "1MB";
const DEFAULT_HEARTBEAT_INTERVAL_S = 1;
const DEFAULT_VERSION = "0.0.1";

export class ReferenceAgent {
  readonly #options: ReferenceAgentOptions;
  readonly #subject: AgentSubject;
  readonly #logger: Logger;
  readonly #minSenderTrust: MinSenderTrust;
  readonly #gate: SenderGate;
  #identity: AgentId | undefined;
  #service: Service | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ReferenceAgentOptions) {
    this.#options = options;
    this.#subject = AgentSubject.new(options.agent, options.owner, options.name);
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#minSenderTrust = options.minSenderTrust ?? DEFAULT_MIN_SENDER_TRUST;
    const accountTokenPosition = normalizeAccountTokenPosition(options.accountTokenPosition);
    this.#gate = new SenderGate({
      minSenderTrust: this.#minSenderTrust,
      replayWindowMs: options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS,
      ...(accountTokenPosition !== undefined ? { accountTokenPosition } : {}),
      ...(options.acceptSender !== undefined ? { acceptSender: options.acceptSender } : {}),
      logger: this.#logger,
    });
  }

  /** The agent ID this instance registered, or `undefined` (set by `start()`). */
  get identity(): AgentId | undefined {
    return this.#identity;
  }

  /** The `min_sender_trust` advertised on the prompt endpoint. */
  get minSenderTrust(): MinSenderTrust {
    return this.#minSenderTrust;
  }

  /** The nonce set / classification gate (for tests that inspect it). */
  get senderGate(): SenderGate {
    return this.#gate;
  }

  /** Prompt endpoint subject this agent listens on (§2 v0.3 — verb-first). */
  get promptSubject(): string {
    return this.#subject.prompt;
  }

  /** Heartbeat subject this agent publishes on (§8.1 v0.3 — `agents.hb.*`). */
  get heartbeatSubject(): string {
    return this.#subject.heartbeat;
  }

  /** Status endpoint subject (§8.7 (v0.3)). */
  get statusSubject(): string {
    return this.#subject.status;
  }

  /** The service id, available after `start()`. Matches heartbeat `instance_id`. */
  get instanceId(): string {
    if (!this.#service) {
      throw new Error("ReferenceAgent.instanceId: agent not started");
    }
    return this.#service.info().id;
  }

  async start(): Promise<void> {
    if (this.#service) return;

    // Same policy as `AgentService.start()`: a mismatching signer throws;
    // no identity → log and register without the identity keys.
    const signer = this.#options.identity?.signer;
    let identity: AgentId | undefined;
    try {
      identity = await selfId(this.#options.nc, signer ? { signer } : {});
    } catch (err) {
      if (err instanceof IdentityMismatchError) throw err;
      this.#logger.warn("ReferenceAgent: starting without identity metadata", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    this.#identity = identity;

    const svcm = new Svcm(this.#options.nc);

    const metadata: Record<string, string> = {
      agent: this.#subject.agent,
      owner: this.#subject.owner,
      protocol_version: `${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`,
      ...this.#options.extraMetadata,
    };
    if (this.#options.session !== undefined) {
      metadata["session"] = this.#options.session;
    }
    if (identity !== undefined) {
      metadata[IDENTITY_METADATA_KEYS.userNkey] = agentIdUser(identity);
      metadata[IDENTITY_METADATA_KEYS.account] = agentIdAccount(identity);
      if (signer) {
        metadata[IDENTITY_METADATA_KEYS.idSig] = await signAgentId({
          signer,
          id: identity,
          agent: this.#subject.agent,
          owner: this.#subject.owner,
          promptSubject: this.#subject.prompt,
        });
      } else {
        delete metadata[IDENTITY_METADATA_KEYS.idSig];
      }
    } else {
      delete metadata[IDENTITY_METADATA_KEYS.userNkey];
      delete metadata[IDENTITY_METADATA_KEYS.account];
      delete metadata[IDENTITY_METADATA_KEYS.idSig];
    }

    this.#service = await svcm.add({
      name: SERVICE_NAME,
      version: this.#options.version ?? DEFAULT_VERSION,
      description: this.#options.description ?? `${this.#subject.agent} reference agent`,
      metadata,
    });

    const attachmentsOk = this.#options.attachmentsOk ?? true;
    // Same clamp behaviour as `AgentService` — see `src/service.ts`. The
    // broker enforces `nc.info.max_payload`; advertising more would break
    // callers without any local validation catching it first.
    const maxPayload = this.#effectiveMaxPayload();
    const promptHandler = this.#options.promptHandler ?? defaultTerminatorHandler;

    this.#service.addEndpoint(PROMPT_ENDPOINT_NAME, {
      subject: this.#subject.prompt,
      queue: PROMPT_QUEUE_GROUP,
      handler: (err, msg) => {
        if (err) return;
        void this.#dispatchPrompt(msg, promptHandler);
      },
      metadata: {
        max_payload: maxPayload,
        attachments_ok: attachmentsOk ? "true" : "false",
        [MIN_SENDER_TRUST_KEY]: this.#minSenderTrust,
      },
    });

    // §8.7 (v0.3): status request/response endpoint. Replies with a freshly-
    // built §8.3 heartbeat payload — same shape, different transport (request/
    // response instead of pub/sub). Same queue group as `prompt` so callers
    // load-balance to one responder per logical agent.
    this.#service.addEndpoint(STATUS_ENDPOINT_NAME, {
      subject: this.#subject.status,
      queue: STATUS_QUEUE_GROUP,
      handler: (err, msg) => {
        if (err) return;
        const service = this.#service;
        if (!service) return;
        // Classify-only; the reply is sent whatever the outcome.
        void this.#gate.classifyStatus(msg).then(
          (sender) => {
            this.#logger.debug("status request", {
              subject: msg.subject,
              sender: formatSender(sender),
            });
          },
          () => undefined,
        );
        const payload = buildHeartbeatPayload(
          this.#subject,
          this.#options.heartbeatIntervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S,
          service.info().id,
          this.#options.session !== undefined ? { session: this.#options.session } : {},
        );
        msg.respond(encodeHeartbeatPayload(payload));
      },
    });

    // "Started" means "registered at the server": a test that discovers or
    // prompts on another connection right after `start()` must not race
    // the endpoint subscriptions (→ no responders).
    await this.#options.nc.flush();

    // §8.2: begin publishing heartbeats AFTER service registration so that
    // callers discovering via $SRV.INFO find the metadata first. We also
    // emit one immediately so tests don't wait a full interval.
    this.#startHeartbeats();
  }

  async stop(): Promise<void> {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#service) {
      await this.#service.stop();
      this.#service = null;
    }
  }

  async #dispatchPrompt(
    msg: ServiceMsg,
    promptHandler: ReferenceAgentPromptHandler,
  ): Promise<void> {
    let sender: SenderInfo | undefined;
    try {
      const admission = await this.#gate.admitPrompt(msg);
      if (!admission.ok) {
        try {
          msg.respondError(admission.code, admission.description);
        } catch {
          /* connection may already be gone */
        }
        // §9.3 — the error frame is not the terminator.
        msg.respond(new Uint8Array(0));
        return;
      }
      sender = admission.sender;
    } catch (err) {
      this.#logger.error("ReferenceAgent: sender classification failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        msg.respondError(500, "sender classification error");
      } catch {
        /* connection may already be gone */
      }
      msg.respond(new Uint8Array(0));
      return;
    }
    try {
      await promptHandler(msg, sender);
    } catch (handlerErr) {
      try {
        msg.respondError(500, "reference agent handler error");
      } catch {
        /* connection may already be gone */
      }
      console.error("ReferenceAgent prompt handler threw", handlerErr);
    }
  }

  /**
   * Mirrors `AgentService.#effectiveMaxPayload`: when no `maxPayload`
   * option is passed, advertise the broker's negotiated
   * `nc.info.max_payload` rather than a stale hardcoded default; when
   * an explicit override is passed, honor it but clamp down to the
   * broker's cap if the override exceeds it.
   */
  #effectiveMaxPayload(): string {
    const serverBytes = this.#options.nc.info?.max_payload ?? 0;
    if (this.#options.maxPayload === undefined) {
      return serverBytes > 0 ? formatHumanBytes(serverBytes) : DEFAULT_MAX_PAYLOAD;
    }
    const override = this.#options.maxPayload;
    const overrideBytes = parseHumanBytes(override);
    if (serverBytes <= 0 || overrideBytes <= serverBytes) {
      return override;
    }
    const clamped = formatHumanBytes(serverBytes);
    this.#logger.warn(
      `ReferenceAgent: maxPayload=${override} (${overrideBytes} bytes) exceeds ` +
        `server limit ${clamped} (${serverBytes} bytes); clamping advertised ` +
        `value to ${clamped}`,
      { maxPayload: override, serverMaxPayload: serverBytes },
    );
    return clamped;
  }

  #startHeartbeats(): void {
    const intervalS = this.#options.heartbeatIntervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S;
    const publish = (): void => {
      const service = this.#service;
      if (!service) return;
      const payload = buildHeartbeatPayload(
        this.#subject,
        intervalS,
        service.info().id,
        this.#options.session !== undefined ? { session: this.#options.session } : {},
      );
      this.#options.nc.publish(this.#subject.heartbeat, encodeHeartbeatPayload(payload));
    };
    publish();
    this.#heartbeatTimer = setInterval(publish, intervalS * 1000);
    // Allow the Node process to exit even if the timer is still active.
    this.#heartbeatTimer.unref?.();
  }
}

function defaultTerminatorHandler(msg: ServiceMsg): void {
  // Spec §6.5: empty body + no headers is the stream terminator.
  // Match `AgentService.tryRespondTerminator` — both produce the same
  // wire bytes, but the explicit `Uint8Array(0)` makes "empty body"
  // unambiguous on inspection.
  msg.respond(new Uint8Array(0));
}

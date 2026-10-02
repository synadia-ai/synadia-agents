// `Agent` — a live handle returned by `Agents.discover()`. Carries the
// metadata parsed from `$SRV.INFO` (spec §4.3) and the `NatsConnection`
// needed to prompt it. Every public field is read-only; all selection is
// done inline by the caller via native `Array` / `Map.groupBy` / `filter`.
//
// Sender identity (extension): when constructed by an `Agents` client the
// handle carries its optional `IdentityContext`, and `prompt()` / `status()`
// attach an `Agent-Sender` header only when identity was explicitly enabled.
//
// Prompt interceptors: the handle also carries its client's interceptors,
// which `prompt()` runs at publish time, in two phases (see
// `prompt/interceptor.ts`).

import { AsyncResource } from "node:async_hooks";
import { Empty, headers, type MsgHdrs, type NatsConnection } from "@nats-io/nats-core";
import type { AgentInfo } from "./discovery/agent-info.js";
import type { EndpointInfo, MinSenderTrust } from "./discovery/endpoint-info.js";
import { NatsAgentError, ProtocolError, SenderSignatureRequiredError } from "./errors.js";
import { decodeHeartbeatPayload, type HeartbeatPayload } from "./heartbeat/payload.js";
import type { AgentId } from "./identity/agent-id.js";
import type { IdentityContext, SenderHeaderPlan } from "./identity/context.js";
import { selfId } from "./identity/self-id.js";
import {
  AGENT_SENDER_HEADER,
  maxSenderHeaderBytes,
  serializeSenderHeader,
} from "./identity/sender-header.js";
import { signedPublishHeaders, toBytes } from "./identity/signed-publish.js";
import { combineAbortSignals } from "./internal/abort.js";
import { type Logger, SILENT_LOGGER } from "./internal/logger.js";
import { STATUS_ENDPOINT_NAME } from "./internal/service-name.js";
import { normalizeAttachments } from "./prompt/attachments.js";
import {
  encodedEnvelopeSize,
  encodeEnvelope,
  isEnvelopeField,
  type RequestEnvelope,
} from "./prompt/envelope.js";
import type {
  PromptExtras,
  PromptInterceptor,
  PromptInterceptorContext,
  PromptSigning,
} from "./prompt/interceptor.js";
import {
  DEFAULT_PROMPT_MAX_WAIT_MS,
  DEFAULT_STATUS_TIMEOUT_MS,
  type PromptOptions,
  type StatusOptions,
} from "./prompt/options.js";
import {
  assertAttachmentsAllowed,
  assertPromptNonEmpty,
  assertWithinMaxPayload,
} from "./prompt/validate.js";
import {
  buildServiceErrorFromMsg,
  PromptStream,
  type PreparedRequest,
} from "./stream/prompt-stream.js";
import { isErrorSignal } from "./stream/terminator.js";

export class Agent {
  // Identity from $SRV.INFO metadata — always populated.
  readonly instanceId: string;
  readonly agent: string;
  readonly owner: string;
  readonly name: string;
  readonly session: string | undefined;
  readonly protocolVersion: string;
  readonly description: string;
  readonly version: string;

  // Prompt addressing + capability metadata.
  readonly promptEndpoint: EndpointInfo;
  readonly metadata: Readonly<Record<string, string>>;
  readonly endpoints: ReadonlyArray<EndpointInfo>;

  // Sender-identity extension (mirrors `AgentInfo`).
  /** `true` iff the prompt endpoint advertises `min_sender_trust`. */
  readonly supportsSenderIdentity: boolean;
  /** The agent ID the instance registered, when present and well-formed. */
  readonly identity: AgentId | undefined;
  /** `true` iff the registration's `id_sig` verifies over the prompt subject. */
  readonly idSigVerified: boolean;

  readonly #nc: NatsConnection;
  readonly #defaultInactivityTimeoutMs: number;
  readonly #closeSignal: AbortSignal | undefined;
  readonly #identity: IdentityContext | undefined;
  readonly #interceptors: ReadonlyArray<PromptInterceptor>;
  readonly #logger: Logger;

  constructor(
    nc: NatsConnection,
    info: AgentInfo,
    defaultInactivityTimeoutMs: number,
    closeSignal: AbortSignal | undefined = undefined,
    identity: IdentityContext | undefined = undefined,
    interceptors: ReadonlyArray<PromptInterceptor> = [],
    logger: Logger = SILENT_LOGGER,
  ) {
    this.#nc = nc;
    this.#defaultInactivityTimeoutMs = defaultInactivityTimeoutMs;
    this.#closeSignal = closeSignal;
    this.#identity = identity;
    this.#interceptors = Object.freeze([...interceptors]);
    this.#logger = logger;
    this.instanceId = info.instanceId;
    this.agent = info.agent;
    this.owner = info.owner;
    this.name = info.name;
    this.session = info.session;
    this.protocolVersion = info.protocolVersion;
    this.description = info.description;
    this.version = info.version;
    this.promptEndpoint = info.promptEndpoint;
    this.metadata = info.metadata;
    this.endpoints = info.endpoints;
    this.supportsSenderIdentity = info.supportsSenderIdentity;
    this.identity = info.identity;
    this.idSigVerified = info.idSigVerified;
  }

  /** The prompt endpoint subject — taken verbatim from `$SRV.INFO` (§4.3). */
  get promptSubject(): string {
    return this.promptEndpoint.subject;
  }

  /** `min_sender_trust` of the prompt endpoint; `undefined` for a 0.3 agent. */
  get minSenderTrust(): MinSenderTrust | undefined {
    return this.promptEndpoint.minSenderTrust;
  }

  /** The `NatsConnection` this agent uses (shared with its `Agents`). */
  get connection(): NatsConnection {
    return this.#nc;
  }

  /** The prompt interceptors `prompt()` runs, in order (inherited from `Agents`). */
  get interceptors(): ReadonlyArray<PromptInterceptor> {
    return this.#interceptors;
  }

  /**
   * Send a prompt (optionally with attachments) and return a
   * {@link PromptStream} to iterate the response.
   *
   * Errors thrown synchronously, BEFORE any wire I/O:
   *   - {@link PromptEmptyError}             — empty prompt (§5.1).
   *   - {@link AttachmentsNotSupportedError} — `attachments_ok=false` (§5.4).
   *   - {@link PayloadTooLargeError}         — envelope (plus the sound
   *     upper bound of an `Agent-Sender` header, when one may be sent)
   *     exceeds `max_payload` (§5.4).
   *   - {@link SenderSignatureRequiredError} — the endpoint declares
   *     `min_sender_trust: signed` and no `identity.signer` is configured.
   *
   * Errors from asynchronous identity resolution can reject the returned
   * promise during preflight. Because identity is resolved again immediately
   * before publish (to account for reconnects), they can also be thrown by
   * the first iterator step. These include {@link NoIdentityError} /
   * {@link IdentityUnavailableError} on a `signed` endpoint,
   * {@link IdentityMismatchError} whenever a signer is configured, and the
   * exact {@link PayloadTooLargeError} re-check once the header size is known.
   *
   * Wire errors thrown from the iterator:
   *   - {@link ServiceError}              — `Nats-Service-Error-Code` header (§9.1);
   *     `401` / `403` for sender-identity refusals.
   *   - {@link StreamStalledError}        — inactivity timeout (§6.6).
   *   - {@link StreamMaxWaitExceededError} — total response time exceeded
   *     `maxWaitMs` (default {@link DEFAULT_PROMPT_MAX_WAIT_MS}, 10 minutes)
   *     without seeing the wire terminator.
   *
   * `opts.subject` / `opts.sub` are for callers behind a remapping
   * service import — see {@link PromptOptions}.
   */
  prompt(text: string, opts: PromptOptions = {}): Promise<PromptStream> {
    assertPromptNonEmpty(text);
    const attachmentInputs = opts.attachments ?? [];
    const hasAttachments = attachmentInputs.length > 0;
    if (hasAttachments) {
      assertAttachmentsAllowed(true, this.promptEndpoint);
    }

    const subject = opts.subject ?? this.promptEndpoint.subject;
    const sub = opts.sub ?? subject;
    const requireSigned = this.promptEndpoint.minSenderTrust === "signed";
    const intercept = this.#interception(text, opts.context ?? EMPTY_CONTEXT, subject);
    const identity = this.#identity;
    if (requireSigned && !identity?.signer) {
      throw new SenderSignatureRequiredError(subject);
    }

    // The caller's own broker may enforce a smaller `max_payload` than
    // the agent advertises (multi-cluster / per-account configs); pass
    // `nc.info?.max_payload` so the validator picks the smaller of the
    // two. Treat 0 / missing as "not declared".
    const connLimit = this.#nc.info?.max_payload;
    // Sound upper bound for the header the request may carry — applied
    // synchronously so the documented throw contract holds; the exact
    // size is re-checked once the identity is known.
    const headerBound = identity?.mayAttachHeader() ? maxSenderHeaderBytes(sub, identity.name) : 0;

    // Fast path: text-only — max_payload check is sync.
    if (!hasAttachments) {
      const envelope: RequestEnvelope = { prompt: text };
      assertWithinMaxPayload(
        encodedEnvelopeSize(envelope),
        this.promptEndpoint,
        connLimit,
        headerBound,
      );
      return this.#buildStream(envelope, subject, sub, requireSigned, opts, intercept);
    }

    // With attachments: load files, then check max_payload on the final encoded size.
    return (async (): Promise<PromptStream> => {
      const attachments = await normalizeAttachments(attachmentInputs);
      const envelope: RequestEnvelope = { prompt: text, attachments };
      assertWithinMaxPayload(
        encodedEnvelopeSize(envelope),
        this.promptEndpoint,
        connLimit,
        headerBound,
      );
      return this.#buildStream(envelope, subject, sub, requireSigned, opts, intercept);
    })();
  }

  async #buildStream(
    envelope: RequestEnvelope,
    subject: string,
    sub: string,
    requireSigned: boolean,
    opts: PromptOptions,
    intercept: Interception | undefined,
  ): Promise<PromptStream> {
    // Encode once; the header (when signed) covers exactly these bytes —
    // unless an interceptor adds fields, when the envelope is encoded again
    // at publish time.
    const payload = encodeEnvelope(envelope);
    const initialPlan = await this.#planHeader(sub, requireSigned);
    if (initialPlan) {
      // Exact re-check with the real header size (§2.4 step 2).
      assertWithinMaxPayload(
        payload.length,
        this.promptEndpoint,
        this.#nc.info?.max_payload,
        initialPlan.wireBytes,
      );
    }
    const identity = this.#identity;
    const identityEnabled =
      identity !== undefined && (identity.signer !== undefined || identity.sendUnsignedClaim);
    const signal = combineAbortSignals([opts.signal, this.#closeSignal]);
    const prepare =
      identityEnabled || intercept !== undefined
        ? (): Promise<PreparedRequest> =>
            this.#prepareAtPublish(
              envelope,
              payload,
              sub,
              requireSigned,
              identityEnabled,
              intercept,
            )
        : undefined;
    return new PromptStream({
      nc: this.#nc,
      subject,
      payload,
      ...(prepare ? { prepare } : {}),
      inactivityTimeoutMs: opts.inactivityTimeoutMs ?? this.#defaultInactivityTimeoutMs,
      maxWaitMs: opts.maxWaitMs ?? DEFAULT_PROMPT_MAX_WAIT_MS,
      signal,
    });
  }

  /**
   * The request as published, prepared on the stream's first iteration.
   *
   * The sender identity is planned again first — a reconnect after
   * `prompt()` may invalidate the initial one, and a captured plan must
   * never survive it. The interceptors' first phase runs next; their
   * fields make the envelope be encoded again, and the exact `max_payload`
   * check covers the bytes that go out. The `Agent-Sender` header is
   * signed over those bytes. Only then, with nothing left that can refuse
   * the prompt, does their second phase run — immediately before the
   * stream publishes what this returns.
   */
  async #prepareAtPublish(
    envelope: RequestEnvelope,
    planned: Uint8Array,
    sub: string,
    requireSigned: boolean,
    identityEnabled: boolean,
    intercept: Interception | undefined,
  ): Promise<PreparedRequest> {
    const plan = identityEnabled ? await this.#planHeader(sub, requireSigned) : undefined;
    let payload = planned;
    let hdrs: MsgHdrs | undefined;
    let collected: CollectedExtras | undefined;
    if (intercept) {
      const extras = (collected = await intercept.extend());
      if (extras.fields !== undefined) {
        payload = encodeEnvelope({ ...envelope, extras: extras.fields });
        if (!plan) {
          assertWithinMaxPayload(payload.length, this.promptEndpoint, this.#nc.info?.max_payload);
        }
      }
      if (extras.headers !== undefined) {
        hdrs = headers();
        for (const [key, value] of Object.entries(extras.headers)) hdrs.set(key, value);
      }
    }
    if (plan) {
      assertWithinMaxPayload(
        payload.length,
        this.promptEndpoint,
        this.#nc.info?.max_payload,
        plan.wireBytes,
      );
      hdrs ??= headers();
      hdrs.set(AGENT_SENDER_HEADER, serializeSenderHeader(await plan.build(payload)));
    }
    if (intercept && collected) await intercept.publish(collected.results);
    return hdrs !== undefined ? { payload, headers: hdrs } : { payload };
  }

  /**
   * Both interceptor phases for one prompt, or `undefined` without
   * interceptors. Bound here, while the async context is still the
   * caller's: they run at publish time, when it may be another one. Both
   * phases get the same context object.
   */
  #interception(
    prompt: string,
    context: Readonly<Record<string, unknown>>,
    subject: string,
  ): Interception | undefined {
    const interceptors = this.#interceptors;
    if (interceptors.length === 0) return undefined;
    const ctx: PromptInterceptorContext = {
      agent: this,
      prompt,
      context,
      connection: this.#nc,
      identity: this.#signing(),
    };
    const logger = this.#logger;
    return {
      extend: AsyncResource.bind(() => collectExtras(interceptors, ctx)),
      publish: AsyncResource.bind((results: ReadonlyArray<PromptExtras | undefined>) =>
        runBeforePublish(interceptors, ctx, results, logger, subject),
      ),
    };
  }

  /** Signing with this handle's identity, for its prompt interceptors. */
  #signing(): PromptSigning {
    const nc = this.#nc;
    const identity = this.#identity;
    return {
      canSign: identity?.signer !== undefined,
      selfId: () => identity?.selfId() ?? selfId(nc),
      publishSigned: async (subject, payload, opts = {}) => {
        const bytes = toBytes(payload);
        const hdrs = await signedPublishHeaders(identity, subject, bytes, opts);
        nc.publish(subject, bytes, { headers: hdrs });
      },
    };
  }

  /**
   * Probe the agent's `status` endpoint (§8.7) and return its heartbeat
   * payload. Attaches an `Agent-Sender` header like `prompt()` does (the
   * receiver classifies it, never rejects on it). Throws
   * {@link ServiceError} on an error-headered reply and
   * {@link ProtocolError} when the reply is not a heartbeat payload.
   */
  async status(opts: StatusOptions = {}): Promise<HeartbeatPayload> {
    const endpoint = this.endpoints.find((e) => e.name === STATUS_ENDPOINT_NAME);
    const subject = opts.subject ?? endpoint?.subject;
    if (subject === undefined) {
      throw new NatsAgentError(`agent ${this.instanceId} declares no status endpoint`);
    }
    const sub = opts.sub ?? subject;
    const plan = await this.#planHeader(sub, false);
    const hdrs = plan ? await this.#headersFor(plan, Empty) : undefined;
    const msg = await this.#nc.request(subject, Empty, {
      timeout: opts.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS,
      ...(hdrs ? { headers: hdrs } : {}),
    });
    if (isErrorSignal(msg)) throw buildServiceErrorFromMsg(msg);
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.string());
    } catch (err) {
      throw new ProtocolError("status reply is not JSON", { cause: err });
    }
    const payload = decodeHeartbeatPayload(parsed);
    if (!payload) throw new ProtocolError("status reply is not a §8.3 heartbeat payload");
    return payload;
  }

  async #planHeader(sub: string, requireSigned: boolean): Promise<SenderHeaderPlan | undefined> {
    const identity = this.#identity;
    if (!identity) return undefined;
    if (!requireSigned && !identity.mayAttachHeader()) return undefined;
    return identity.plan(sub, requireSigned);
  }

  async #headersFor(plan: SenderHeaderPlan, payload: Uint8Array): Promise<MsgHdrs> {
    const h = headers();
    h.set(AGENT_SENDER_HEADER, serializeSenderHeader(await plan.build(payload)));
    return h;
  }
}

const EMPTY_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({});

/** The interceptors' additions to one prompt, merged, and what each returned. */
interface CollectedExtras {
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Each interceptor's `beforePrompt` result, in order, for its `beforePublish`. */
  readonly results: ReadonlyArray<PromptExtras | undefined>;
}

/** The two interceptor phases of one prompt, bound to the caller's context. */
interface Interception {
  readonly extend: () => Promise<CollectedExtras>;
  readonly publish: (results: ReadonlyArray<PromptExtras | undefined>) => Promise<void>;
}

/**
 * Run `interceptors` in order and merge what they add; a later one wins a
 * key an earlier one also set. A field the envelope codec owns, or the
 * `Agent-Sender` header, is refused rather than silently dropped: an
 * interceptor that sets one has a bug worth hearing about.
 */
async function collectExtras(
  interceptors: ReadonlyArray<PromptInterceptor>,
  ctx: PromptInterceptorContext,
): Promise<CollectedExtras> {
  // Maps, turned into objects by `Object.fromEntries`, which defines every
  // key as an own property — a field named `__proto__` included.
  const fields = new Map<string, unknown>();
  const hdrs = new Map<string, string>();
  const results: Array<PromptExtras | undefined> = [];
  for (const interceptor of interceptors) {
    const extras = (await interceptor.beforePrompt(ctx)) as PromptExtras | undefined;
    results.push(extras);
    if (extras === undefined) continue;
    for (const [key, value] of Object.entries(extras.fields ?? {})) {
      if (isEnvelopeField(key)) {
        throw new NatsAgentError(`prompt interceptor: envelope field \`${key}\` is not an extra`);
      }
      fields.set(key, value);
    }
    for (const [key, value] of Object.entries(extras.headers ?? {})) {
      if (key.toLowerCase() === AGENT_SENDER_HEADER.toLowerCase()) {
        throw new NatsAgentError(
          `prompt interceptor: the ${AGENT_SENDER_HEADER} header is the SDK's`,
        );
      }
      hdrs.set(key, value);
    }
  }
  return {
    ...(fields.size > 0 ? { fields: Object.fromEntries(fields) } : {}),
    ...(hdrs.size > 0 ? { headers: Object.fromEntries(hdrs) } : {}),
    results,
  };
}

/**
 * The interceptors' second phase, in order, each with what its own first
 * phase returned. The prompt is due to go out by now, so a throw does not
 * stop it — nor the interceptors after the one that threw: it is logged
 * (the interceptor is application code, so its exception is not).
 */
async function runBeforePublish(
  interceptors: ReadonlyArray<PromptInterceptor>,
  ctx: PromptInterceptorContext,
  results: ReadonlyArray<PromptExtras | undefined>,
  logger: Logger,
  subject: string,
): Promise<void> {
  for (const [index, interceptor] of interceptors.entries()) {
    if (interceptor.beforePublish === undefined) continue;
    try {
      await interceptor.beforePublish(ctx, results[index]);
    } catch {
      logger.error("prompt interceptor beforePublish failed; publishing the prompt", {
        subject,
        interceptor: index,
        error: "exception",
      });
    }
  }
}

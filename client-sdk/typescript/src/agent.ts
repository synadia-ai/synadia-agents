// `Agent` — a live handle returned by `Agents.discover()`. Carries the
// metadata parsed from `$SRV.INFO` (spec §4.3) and the `NatsConnection`
// needed to prompt it. Every public field is read-only; all selection is
// done inline by the caller via native `Array` / `Map.groupBy` / `filter`.
//
// Sender identity (extension): when constructed by an `Agents` client the
// handle carries its optional `IdentityContext`, and `prompt()` / `status()`
// attach an `Agent-Sender` header only when identity was explicitly enabled.

import { Empty, headers, type MsgHdrs, type NatsConnection } from "@nats-io/nats-core";
import type { AgentInfo } from "./discovery/agent-info.js";
import type { EndpointInfo, MinSenderTrust } from "./discovery/endpoint-info.js";
import { NatsAgentError, ProtocolError, SenderSignatureRequiredError } from "./errors.js";
import { decodeHeartbeatPayload, type HeartbeatPayload } from "./heartbeat/payload.js";
import type { AgentId } from "./identity/agent-id.js";
import type { IdentityContext, SenderHeaderPlan } from "./identity/context.js";
import {
  AGENT_SENDER_HEADER,
  maxSenderHeaderBytes,
  serializeSenderHeader,
} from "./identity/sender-header.js";
import { combineAbortSignals } from "./internal/abort.js";
import {
  activeTrace,
  assertValidTraceOptions,
  buildEdgeRecord,
  DEFAULT_EDGE_SUBJECT,
  inheritedTraceOptions,
  type BuiltEdgeRecord,
  randomThreadId,
  validToolCallId,
  type TraceOptions,
} from "./trace.js";
import { STATUS_ENDPOINT_NAME } from "./internal/service-name.js";
import { normalizeAttachments } from "./prompt/attachments.js";
import { encodedEnvelopeSize, encodeEnvelope, type RequestEnvelope } from "./prompt/envelope.js";
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
import { buildServiceErrorFromMsg, PromptStream } from "./stream/prompt-stream.js";
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
  readonly #trace: TraceOptions | undefined;

  constructor(
    nc: NatsConnection,
    info: AgentInfo,
    defaultInactivityTimeoutMs: number,
    closeSignal: AbortSignal | undefined = undefined,
    identity: IdentityContext | undefined = undefined,
    trace: TraceOptions | undefined = undefined,
  ) {
    this.#nc = nc;
    this.#defaultInactivityTimeoutMs = defaultInactivityTimeoutMs;
    this.#closeSignal = closeSignal;
    this.#identity = identity;
    assertValidTraceOptions(trace);
    this.#trace = trace;
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

  /**
   * `true` iff tracing was enabled on this handle. Inherited tracing (from
   * an enclosing agent service) is resolved per call, so this reports only
   * the handle's own configuration.
   */
  get tracingEnabled(): boolean {
    return this.#trace !== undefined;
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

    // Tracing is best-effort and shouldn't stop an agent from sending out
    // a prompt. Invalid tools are just ignored.
    const toolCallId =
      opts.toolCallId !== undefined && validToolCallId(opts.toolCallId) ? opts.toolCallId : null;

    // Effective configuration: this handle's own, else the one handed down
    // by the enclosing agent service, else tracing is off.
    const trace = this.#trace ?? inheritedTraceOptions();

    // If tracing is enabled, mint a thread ID for this prompt and inherit
    // the root and parent from the ambient trace (a root when none is bound).
    const lineage = trace !== undefined ? mintLineage() : undefined;
    let edge: (() => Promise<void>) | undefined;
    if (lineage !== undefined) {
      // The edge goes out immediately before the prompt, so an observer
      // sees the node before it runs.
      const edgeSubject =
        trace?.edgeSubject === undefined ? DEFAULT_EDGE_SUBJECT : trace.edgeSubject;
      // Consumers ignore unsigned records, so publishing without a signer
      // would be pure waste: warn once per connection and skip. Minting and
      // envelope lineage need no identity and still happen, so downstream
      // agents that do have one keep tracing.
      if (edgeSubject !== null && !identity?.signer) {
        warnEdgesUnsigned(this.#nc);
      } else if (edgeSubject !== null) {
        // Lineage is captured here, where the ambient trace is still the
        // caller's. The record itself is built at publish time, so its
        // `ts` says when the prompt actually went out — not when it was
        // planned — and a prompt that never goes out (never iterated, or
        // rejected by validation below) publishes no edge.
        const { threadId, parentId, rootId, turnCountHint } = lineage;
        edge = (): Promise<void> =>
          this.#publishEdge(
            edgeSubject,
            buildEdgeRecord(threadId, parentId ?? null, rootId, toolCallId, turnCountHint),
          );
      }
    }

    // The envelope carries only what the receiver must inherit; the parent
    // stays in the edge record and never transits the child.
    const envLineage =
      lineage !== undefined ? { threadId: lineage.threadId, rootId: lineage.rootId } : undefined;

    // Fast path: text-only — max_payload check is sync.
    if (!hasAttachments) {
      const envelope: RequestEnvelope = { prompt: text, ...envLineage };
      assertWithinMaxPayload(
        encodedEnvelopeSize(envelope),
        this.promptEndpoint,
        connLimit,
        headerBound,
      );
      return this.#buildStream(envelope, subject, sub, requireSigned, opts, edge);
    }

    // With attachments: load files, then check max_payload on the final encoded size.
    return (async (): Promise<PromptStream> => {
      const attachments = await normalizeAttachments(attachmentInputs);
      const envelope: RequestEnvelope = { prompt: text, attachments, ...envLineage };
      assertWithinMaxPayload(
        encodedEnvelopeSize(envelope),
        this.promptEndpoint,
        connLimit,
        headerBound,
      );
      return this.#buildStream(envelope, subject, sub, requireSigned, opts, edge);
    })();
  }

  async #buildStream(
    envelope: RequestEnvelope,
    subject: string,
    sub: string,
    requireSigned: boolean,
    opts: PromptOptions,
    edge: (() => Promise<void>) | undefined,
  ): Promise<PromptStream> {
    // Encode once; the header (when signed) covers exactly these bytes.
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
    return new PromptStream({
      nc: this.#nc,
      subject,
      payload,
      // Re-plan at publish time. A reconnect after `prompt()` may invalidate
      // the initial identity; a captured plan must never survive it.
      ...(identityEnabled
        ? { buildHeaders: () => this.#headersAtPublish(sub, requireSigned, payload) }
        : {}),
      ...(edge ? { beforePublish: edge } : {}),
      inactivityTimeoutMs: opts.inactivityTimeoutMs ?? this.#defaultInactivityTimeoutMs,
      maxWaitMs: opts.maxWaitMs ?? DEFAULT_PROMPT_MAX_WAIT_MS,
      signal,
    });
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

  /**
   * Publish one signed edge record.
   *
   * The signature covers the short-form subject the record is published
   * to: per the identity design a remap that only drops the account token
   * is not a rename, so no `sub` override is needed. Consumers verify in
   * stored mode.
   *
   * Fail-open — a failed publish never fails the prompt.
   */
  async #publishEdge(subject: string, record: BuiltEdgeRecord): Promise<void> {
    try {
      const plan = await this.#planHeader(subject, true);
      if (!plan) throw new SenderSignatureRequiredError(subject);
      const hdrs = await this.#headersFor(plan, record.payload);
      hdrs.set(MSG_ID_HEADER, record.recordId);
      this.#nc.publish(subject, record.payload, { headers: hdrs });
    } catch (err) {
      console.warn(`@synadia-ai/agents: failed to publish edge record on ${subject}`, err);
    }
  }

  async #headersAtPublish(
    sub: string,
    requireSigned: boolean,
    payload: Uint8Array,
  ): Promise<MsgHdrs | undefined> {
    const plan = await this.#planHeader(sub, requireSigned);
    if (!plan) return undefined;
    assertWithinMaxPayload(
      payload.length,
      this.promptEndpoint,
      this.#nc.info?.max_payload,
      plan.wireBytes,
    );
    return this.#headersFor(plan, payload);
  }
}

// Connections already warned that their edge records go nowhere. One
// warning per connection: a per-prompt log would itself be a way for
// observability to disturb an agent. Same string as agents.ts's
// NATS_MSG_ID_HEADER, spelled again here because agents.ts imports this
// module.
const MSG_ID_HEADER = "Nats-Msg-Id";
const warnedUnsigned = new WeakSet<NatsConnection>();

function warnEdgesUnsigned(nc: NatsConnection): void {
  if (warnedUnsigned.has(nc)) return;
  warnedUnsigned.add(nc);
  console.warn(
    "@synadia-ai/agents: tracing is enabled but no identity signer is configured; " +
      "edge records are not published (consumers ignore unsigned records). " +
      "Pass identity: { signer } to sign them.",
  );
}

// The thread ID names this prompt's execution. Inside a prompt handler the
// ambient trace supplies the tree root and this prompt's parent; with none
// bound, the prompt starts its own tree.
function mintLineage(): {
  threadId: string;
  rootId: string;
  parentId?: string;
  turnCountHint: number;
} {
  const threadId = randomThreadId();
  const ambient = activeTrace();
  if (ambient === undefined) return { threadId, rootId: threadId, turnCountHint: 0 };
  return {
    threadId,
    rootId: ambient.rootId,
    parentId: ambient.threadId,
    turnCountHint: ambient.turnCountHint,
  };
}

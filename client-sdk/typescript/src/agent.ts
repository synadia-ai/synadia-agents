// `Agent` — a live handle returned by `Agents.discover()`. Carries the
// metadata parsed from `$SRV.INFO` (spec §4.3) and the `NatsConnection`
// needed to prompt it. Every public field is read-only; all selection is
// done inline by the caller via native `Array` / `Map.groupBy` / `filter`.

import type { NatsConnection } from "@nats-io/nats-core";
import type { AgentInfo } from "./discovery/agent-info.js";
import type { EndpointInfo } from "./discovery/endpoint-info.js";
import { combineAbortSignals } from "./internal/abort.js";
import { normalizeAttachments } from "./prompt/attachments.js";
import { encodedEnvelopeSize, type RequestEnvelope } from "./prompt/envelope.js";
import { DEFAULT_PROMPT_MAX_WAIT_MS, type PromptOptions } from "./prompt/options.js";
import {
  assertAttachmentsAllowed,
  assertPromptNonEmpty,
  assertWithinMaxPayload,
} from "./prompt/validate.js";
import { PromptStream } from "./stream/prompt-stream.js";

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

  readonly #nc: NatsConnection;
  readonly #defaultInactivityTimeoutMs: number;
  readonly #closeSignal: AbortSignal | undefined;

  constructor(
    nc: NatsConnection,
    info: AgentInfo,
    defaultInactivityTimeoutMs: number,
    closeSignal: AbortSignal | undefined = undefined,
  ) {
    this.#nc = nc;
    this.#defaultInactivityTimeoutMs = defaultInactivityTimeoutMs;
    this.#closeSignal = closeSignal;
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
  }

  /** The prompt endpoint subject — taken verbatim from `$SRV.INFO` (§4.3). */
  get promptSubject(): string {
    return this.promptEndpoint.subject;
  }

  /** The `NatsConnection` this agent uses (shared with its `Agents`). */
  get connection(): NatsConnection {
    return this.#nc;
  }

  /**
   * Send a prompt (optionally with attachments) and return a
   * {@link PromptStream} to iterate the response.
   *
   * Errors rejected BEFORE any wire I/O:
   *   - {@link PromptEmptyError}             — empty prompt (§5.1).
   *   - {@link AttachmentsNotSupportedError} — `attachments_ok=false` (§5.4).
   *   - {@link PayloadTooLargeError}         — envelope exceeds `max_payload` (§5.4).
   *
   * Wire errors thrown from the iterator:
   *   - {@link ServiceError}       — `Nats-Service-Error-Code` header (§9.1).
   *   - {@link StreamStalledError} — inactivity timeout (§6.6).
   */
  prompt(text: string, opts: PromptOptions = {}): Promise<PromptStream> {
    assertPromptNonEmpty(text);
    const attachmentInputs = opts.attachments ?? [];
    const hasAttachments = attachmentInputs.length > 0;
    if (hasAttachments) {
      assertAttachmentsAllowed(true, this.promptEndpoint);
    }

    // The caller's own broker may enforce a smaller `max_payload` than
    // the agent advertises (multi-cluster / per-account configs); pass
    // `nc.info?.max_payload` so the validator picks the smaller of the
    // two. Treat 0 / missing as "not declared".
    const connLimit = this.#nc.info?.max_payload;

    // Fast path: text-only — max_payload check is sync.
    if (!hasAttachments) {
      const envelope: RequestEnvelope = { prompt: text };
      assertWithinMaxPayload(encodedEnvelopeSize(envelope), this.promptEndpoint, connLimit);
      return Promise.resolve(this.#buildStream(envelope, opts));
    }

    // With attachments: load files, then check max_payload on the final encoded size.
    return (async (): Promise<PromptStream> => {
      const attachments = await normalizeAttachments(attachmentInputs);
      const envelope: RequestEnvelope = { prompt: text, attachments };
      assertWithinMaxPayload(encodedEnvelopeSize(envelope), this.promptEndpoint, connLimit);
      return this.#buildStream(envelope, opts);
    })();
  }

  #buildStream(envelope: RequestEnvelope, opts: PromptOptions): PromptStream {
    const signal = combineAbortSignals([opts.signal, this.#closeSignal]);
    return new PromptStream(
      this.#nc,
      this.promptEndpoint.subject,
      envelope,
      opts.inactivityTimeoutMs ?? this.#defaultInactivityTimeoutMs,
      opts.maxWaitMs ?? DEFAULT_PROMPT_MAX_WAIT_MS,
      signal,
    );
  }
}

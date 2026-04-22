// RemoteAgent — a handle to a discovered agent that can be prompted.

import type { NatsConnection } from "@nats-io/nats-core";
import type { DiscoveredAgent } from "./discovery/discovered-agent.js";
import { combineAbortSignals } from "./internal/abort.js";
import { normalizeAttachments } from "./prompt/attachments.js";
import { encodedEnvelopeSize, type RequestEnvelope } from "./prompt/envelope.js";
import type { PromptOptions } from "./prompt/options.js";
import {
  assertAttachmentsAllowed,
  assertPromptNonEmpty,
  assertWithinMaxPayload,
} from "./prompt/validate.js";
import { PromptStream } from "./stream/prompt-stream.js";

export class RemoteAgent {
  constructor(
    private readonly _nc: NatsConnection,
    private readonly _descriptor: DiscoveredAgent,
    private readonly _defaultInactivityTimeoutMs: number,
    private readonly _clientCloseSignal: AbortSignal | undefined = undefined,
  ) {}

  /** The `DiscoveredAgent` record this handle refers to. */
  get descriptor(): DiscoveredAgent {
    return this._descriptor;
  }

  /** Service instance id — matches `heartbeat.instance_id`. */
  get instanceId(): string {
    return this._descriptor.instanceId;
  }

  /** The prompt endpoint subject, taken verbatim from `$SRV.INFO` (§4.3). */
  get promptSubject(): string {
    return this._descriptor.promptEndpoint.subject;
  }

  /** The `NatsConnection` this remote uses (shared with its `Client`). */
  get connection(): NatsConnection {
    return this._nc;
  }

  /**
   * Send a prompt (optionally with attachments) and return a
   * {@link PromptStream} to iterate the response.
   *
   * `prompt()` is always `async` so attachment file I/O and validation
   * compose cleanly. Local validation errors reject the returned promise
   * — they do NOT hit the wire — so the result is equivalent to a
   * "fail locally" contract: callers catch `AttachmentsNotSupportedError`
   * / `PayloadTooLargeError` before any NATS traffic happens.
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
    // Sync validation — throws before any Promise is constructed.
    assertPromptNonEmpty(text);
    const attachmentInputs = opts.attachments ?? [];
    const hasAttachments = attachmentInputs.length > 0;
    if (hasAttachments) {
      // attachments_ok is a sync, file-I/O-free check — fail locally.
      assertAttachmentsAllowed(true, this._descriptor.promptEndpoint);
    }

    // Fast path: text-only — max_payload check is also sync.
    if (!hasAttachments) {
      const envelope: RequestEnvelope = { prompt: text };
      assertWithinMaxPayload(encodedEnvelopeSize(envelope), this._descriptor.promptEndpoint);
      return Promise.resolve(this.#buildStream(envelope, opts));
    }

    // With attachments: load files, then check max_payload on the final encoded size.
    return (async (): Promise<PromptStream> => {
      const attachments = await normalizeAttachments(attachmentInputs);
      const envelope: RequestEnvelope = { prompt: text, attachments };
      assertWithinMaxPayload(encodedEnvelopeSize(envelope), this._descriptor.promptEndpoint);
      return this.#buildStream(envelope, opts);
    })();
  }

  #buildStream(envelope: RequestEnvelope, opts: PromptOptions): PromptStream {
    const signal = combineAbortSignals([opts.signal, this._clientCloseSignal]);
    return new PromptStream(
      this._nc,
      this._descriptor.promptEndpoint.subject,
      envelope,
      opts.inactivityTimeoutMs ?? this._defaultInactivityTimeoutMs,
      signal,
    );
  }
}

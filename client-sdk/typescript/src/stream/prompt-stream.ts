// PromptStream — the user-facing stream of typed events yielded by
// `RemoteAgent.prompt`. Implements `AsyncIterable<StreamMessage>` so the
// caller writes `for await (const msg of stream) { ... }`.
//
// Wire behaviour:
//   - Subscribes to a fresh reply inbox, flushes the SUB to the server,
//     publishes the request envelope with that inbox as `reply`.
//   - Yields `{ type: "response" }`, `{ type: "status" }`, `QueryEvent` per
//     §6.3–§7.
//   - Emits a synthetic `{ type: "status", status: "done" }` when the wire
//     terminator (empty body + no headers, §6.5) arrives.
//   - Throws `ServiceError` on a `Nats-Service-Error-Code` header (§9.1).
//   - Throws `StreamStalledError` on inactivity timeout (§6.6).
//   - `cancel()` and early break from `for await` both unsubscribe cleanly.

import { createInbox, type Msg, type NatsConnection, type Subscription } from "@nats-io/nats-core";
import { ServiceError, StreamStalledError, type ServiceErrorBody } from "../errors.js";
import { abortError } from "../internal/abort.js";
import { encodeEnvelope, type RequestEnvelope } from "../prompt/envelope.js";
import { buildQueryEvent, type QueryEvent } from "../query/query-event.js";
import { decodeChunk, type DecodedAttachment, type DecodedChunk } from "./chunk-decoder.js";
import { withInactivityTimeout } from "./inactivity.js";
import { isErrorSignal, isTerminator } from "./terminator.js";

export type ResponseAttachment = DecodedAttachment;

export type StreamMessage =
  | {
      readonly type: "response";
      readonly text: string;
      readonly attachments?: ReadonlyArray<ResponseAttachment>;
    }
  | { readonly type: "status"; readonly status: string }
  | QueryEvent;

export class PromptStream implements AsyncIterable<StreamMessage> {
  readonly #nc: NatsConnection;
  readonly #requestSubject: string;
  readonly #envelope: RequestEnvelope;
  readonly #replySubject: string;
  readonly #inactivityTimeoutMs: number;
  readonly #signal: AbortSignal | undefined;
  #sub: Subscription | null = null;
  #iterated = false;
  #cancelled = false;

  constructor(
    nc: NatsConnection,
    requestSubject: string,
    envelope: RequestEnvelope,
    inactivityTimeoutMs: number,
    signal?: AbortSignal,
  ) {
    this.#nc = nc;
    this.#requestSubject = requestSubject;
    this.#envelope = envelope;
    this.#replySubject = createInbox();
    this.#inactivityTimeoutMs = inactivityTimeoutMs;
    this.#signal = signal;
  }

  /** The NATS reply inbox this stream is listening on. Exposed for debugging. */
  get replySubject(): string {
    return this.#replySubject;
  }

  /**
   * Unsubscribe the reply inbox and end the stream cleanly. Subsequent
   * `for await` iterations over this stream exit without throwing.
   */
  cancel(): void {
    this.#cancelled = true;
    this.#sub?.unsubscribe();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamMessage> {
    if (this.#iterated) {
      throw new Error("PromptStream is single-use: a stream cannot be iterated more than once");
    }
    this.#iterated = true;
    if (this.#cancelled) return;
    if (this.#signal?.aborted) throw abortError(this.#signal);

    const sub = this.#nc.subscribe(this.#replySubject);
    this.#sub = sub;
    // Flush so the SUB is at the server before the request is published —
    // otherwise the agent could start replying before we're subscribed.
    await this.#nc.flush();
    this.#nc.publish(this.#requestSubject, encodeEnvelope(this.#envelope), {
      reply: this.#replySubject,
    });

    let onAbort: (() => void) | undefined;
    if (this.#signal) {
      onAbort = (): void => {
        this.#cancelled = true; // mark so we distinguish "closed by abort" vs "stalled"
        sub.unsubscribe();
      };
      this.#signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const iter = withInactivityTimeout(
        sub,
        this.#inactivityTimeoutMs,
        () => new StreamStalledError(this.#inactivityTimeoutMs),
      );
      for await (const msg of iter) {
        if (this.#signal?.aborted) throw abortError(this.#signal);
        if (isErrorSignal(msg)) {
          throw buildServiceErrorFromMsg(msg);
        }
        if (isTerminator(msg)) {
          yield { type: "status", status: "done" };
          return;
        }
        let decoded: DecodedChunk | null;
        try {
          decoded = decodeChunk(msg.data);
        } catch {
          // Malformed chunk — §6.6 says drop unknown types silently. We
          // treat a malformed KNOWN chunk the same way: log would help
          // debugging but we don't want to take down the stream.
          continue;
        }
        if (!decoded) continue; // unknown `type` silently dropped per §6.6
        yield toStreamMessage(decoded, this.#nc);
      }
      // Subscription closed without a terminator. Three possibilities:
      //   - explicit cancel() / AbortSignal fired → exit cleanly (for
      //     cancel) or throw the signal's reason (for abort).
      //   - network / server closed the subscription → stalled.
      if (this.#signal?.aborted) {
        throw abortError(this.#signal);
      }
      if (!this.#cancelled) {
        throw new StreamStalledError(this.#inactivityTimeoutMs);
      }
    } finally {
      if (onAbort && this.#signal) this.#signal.removeEventListener("abort", onAbort);
      sub.unsubscribe();
      this.#sub = null;
    }
  }
}

function toStreamMessage(decoded: DecodedChunk, nc: NatsConnection): StreamMessage {
  switch (decoded.type) {
    case "response":
      return decoded.attachments !== undefined
        ? { type: "response", text: decoded.text, attachments: decoded.attachments }
        : { type: "response", text: decoded.text };
    case "status":
      return { type: "status", status: decoded.status };
    case "query":
      return buildQueryEvent(nc, {
        id: decoded.id,
        replySubject: decoded.replySubject,
        prompt: decoded.prompt,
        ...(decoded.attachments !== undefined ? { attachments: decoded.attachments } : {}),
      });
  }
}

function buildServiceErrorFromMsg(msg: Msg): ServiceError {
  const h = msg.headers;
  const codeStr = h?.get("Nats-Service-Error-Code") ?? "500";
  const code = Number(codeStr);
  const description = h?.get("Nats-Service-Error") ?? "";
  let body: ServiceErrorBody | undefined;
  if (msg.data.length > 0) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.data)) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as ServiceErrorBody;
      }
    } catch {
      /* non-JSON body is allowed per §9.1 — leave body undefined */
    }
  }
  return new ServiceError(Number.isFinite(code) ? code : 500, description, body);
}

// PromptStream — the user-facing stream of typed events yielded by
// `Agent.prompt`. Implements `AsyncIterable<StreamMessage>` so the
// caller writes `for await (const msg of stream) { ... }`.
//
// Wire behavior:
//   - Calls `nc.requestMany(subject, payload, { strategy: "sentinel", maxWait, headers })`
//     on the first iteration. The connection's mux inbox handles the reply
//     routing; the empty-body terminator (§6.5) ends the iterator.
//   - The optional `buildHeaders` callback runs at publish time (inside
//     that first iteration), so an `Agent-Sender` header's `ts` / nonce
//     are fresh even when the caller iterates late; the signature covers
//     the exact `payload` bytes handed in.
//   - Yields `{ type: "response" }`, `{ type: "status" }`, `QueryEvent` per
//     §6.3–§7.
//   - Emits a synthetic `{ type: "status", status: "done" }` when the wire
//     terminator (empty body + no headers, §6.5) arrives.
//   - Throws `ServiceError` on a `Nats-Service-Error-Code` header (§9.1).
//   - Throws `StreamStalledError` on inactivity timeout (§6.6).
//   - Throws `StreamMaxWaitExceededError` if `maxWaitMs` elapses without
//     a terminator (sentinel strategy's absolute ceiling).
//   - `cancel()` and early break from `for await` both stop the iterator
//     cleanly.

import type { Msg, MsgHdrs, NatsConnection, QueuedIterator } from "@nats-io/nats-core";
import {
  ServiceError,
  StreamMaxWaitExceededError,
  StreamStalledError,
  type ServiceErrorBody,
} from "../errors.js";
import { abortError } from "../internal/abort.js";
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

export interface PromptStreamOptions {
  readonly nc: NatsConnection;
  /** The subject the request is published to. */
  readonly subject: string;
  /** The exact request bytes (encoded once by `Agent.prompt()`). */
  readonly payload: Uint8Array;
  /**
   * Builds the request headers at publish time (first iteration). Used
   * for the `Agent-Sender` header, signed over `payload`. `undefined`
   * → no headers.
   */
  readonly buildHeaders?: () => Promise<MsgHdrs | undefined>;
  /**
   * Runs once at publish time, immediately before the request goes out.
   * Used for the observability edge record, so an observer sees the node
   * before it runs — and so a prompt that is never iterated, or that
   * fails validation, publishes no edge at all.
   */
  readonly beforePublish?: () => Promise<void>;
  readonly inactivityTimeoutMs: number;
  readonly maxWaitMs: number;
  readonly signal?: AbortSignal;
}

export class PromptStream implements AsyncIterable<StreamMessage> {
  readonly #nc: NatsConnection;
  readonly #requestSubject: string;
  readonly #payload: Uint8Array;
  readonly #buildHeaders: (() => Promise<MsgHdrs | undefined>) | undefined;
  readonly #beforePublish: (() => Promise<void>) | undefined;
  readonly #inactivityTimeoutMs: number;
  readonly #maxWaitMs: number;
  readonly #signal: AbortSignal | undefined;
  #iter: QueuedIterator<Msg> | null = null;
  #iterated = false;
  #cancelled = false;

  constructor(options: PromptStreamOptions) {
    this.#nc = options.nc;
    this.#requestSubject = options.subject;
    this.#payload = options.payload;
    this.#buildHeaders = options.buildHeaders;
    this.#beforePublish = options.beforePublish;
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs;
    this.#maxWaitMs = options.maxWaitMs;
    this.#signal = options.signal;
  }

  /** The subject this stream publishes its request to. */
  get subject(): string {
    return this.#requestSubject;
  }

  /**
   * Stop the underlying request iterator and end the stream cleanly.
   * Subsequent `for await` iterations over this stream exit without throwing.
   */
  cancel(): void {
    this.#cancelled = true;
    this.#iter?.stop();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamMessage> {
    if (this.#iterated) {
      throw new Error("PromptStream is single-use: a stream cannot be iterated more than once");
    }
    this.#iterated = true;
    if (this.#cancelled) return;
    if (this.#signal?.aborted) throw abortError(this.#signal);

    // The `NatsConnection` interface types `requestMany` as returning a bare
    // `AsyncIterable<Msg>`, but the concrete implementations (nats-core /
    // transport-node / Bun ws) all return a `QueuedIterator<Msg>` whose
    // `.stop()` is the only way to bail out early without waiting for
    // `maxWait` to expire. Cast at the boundary.
    if (this.#beforePublish) await this.#beforePublish();
    // Headers are built here — at publish time — so a signed
    // `Agent-Sender` carries a fresh `ts` and nonce.
    const hdrs = this.#buildHeaders ? await this.#buildHeaders() : undefined;
    const iter = (await this.#nc.requestMany(this.#requestSubject, this.#payload, {
      strategy: "sentinel",
      maxWait: this.#maxWaitMs,
      ...(hdrs ? { headers: hdrs } : {}),
    })) as QueuedIterator<Msg>;
    this.#iter = iter;
    // cancel() may have fired during the requestMany await — the early
    // check above only covers cancellation before iteration started.
    if (this.#cancelled) {
      iter.stop();
      return;
    }
    if (this.#signal?.aborted) {
      iter.stop();
      throw abortError(this.#signal);
    }

    let onAbort: (() => void) | undefined;
    if (this.#signal) {
      onAbort = (): void => {
        this.#cancelled = true; // mark so we distinguish "closed by abort" vs "stalled"
        iter.stop();
      };
      this.#signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const timed = withInactivityTimeout(
        iter,
        this.#inactivityTimeoutMs,
        () => new StreamStalledError(this.#inactivityTimeoutMs),
      );
      for await (const msg of timed) {
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
      // The terminator branch above always `return`s, so reaching here
      // means the iterator drained without one. Possible sources:
      //   - AbortSignal fired → throw the signal's reason.
      //   - cancel() fired → exit cleanly.
      //   - maxWait elapsed → throw StreamMaxWaitExceededError.
      if (this.#signal?.aborted) {
        throw abortError(this.#signal);
      }
      if (this.#cancelled) return;
      throw new StreamMaxWaitExceededError(this.#maxWaitMs);
    } finally {
      if (onAbort && this.#signal) this.#signal.removeEventListener("abort", onAbort);
      iter.stop();
      this.#iter = null;
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

/** Turn a `Nats-Service-Error-Code`-headered message into a {@link ServiceError} (§9.1). */
export function buildServiceErrorFromMsg(msg: Msg): ServiceError {
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

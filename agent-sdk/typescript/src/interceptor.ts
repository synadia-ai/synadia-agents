// Request interceptors — the host-side hook around a prompt handler.
//
// `AgentService` runs its interceptors for every admitted `prompt` request:
// after the envelope is decoded and the sender classified, before the §6.4
// ack. An interceptor sees the decoded envelope — the fields the protocol
// does not define in `envelope.extras` (§5.6) — the classified sender, the
// subject and the request's headers. It may refuse the request by throwing
// before it calls `next()`, and it may run `next()` inside a context of its
// own (`AsyncLocalStorage.run`), which the handler and everything it awaits
// then see. What the extra fields and headers mean is the interceptor's
// business; the SDK gives them none.

import type { MsgHdrs } from "@nats-io/nats-core";
import type { RequestEnvelope, SenderInfo } from "@synadia-ai/agents";

/** What a {@link RequestInterceptor} sees. */
export interface RequestInterceptorContext {
  /** The decoded envelope; top-level fields the protocol does not define are in `extras`. */
  readonly envelope: RequestEnvelope;
  /** The classified sender, as the handler gets it in `PromptResponse.sender`. */
  readonly sender: SenderInfo | undefined;
  /** The subject the request arrived on. */
  readonly subject: string;
  /** The request's NATS headers, when it carried any. */
  readonly headers: MsgHdrs | undefined;
}

/**
 * A host-side hook around the prompt handler. `next()` acks the request,
 * runs the interceptors after this one and then the handler, and resolves
 * when they are done — or rejects with what they threw, which an
 * interceptor may let through or replace. An interceptor must call `next()`
 * once or throw: returning without calling it answers the caller `500`. A
 * throw after `next()` resolved — the handler's reply already out in full —
 * leaves that reply standing and is logged with a fixed line, never the
 * error's details: an interceptor that wants those logged logs them itself.
 */
export interface RequestInterceptor {
  aroundRequest(ctx: RequestInterceptorContext, next: () => Promise<void>): Promise<void>;
}

/**
 * Thrown to refuse a request with a §9 error: `AgentService` answers with
 * `code` and `description` (single-lined and capped at 200 characters), then
 * the terminator. Thrown before `next()`, the caller gets no ack. For a
 * malformed request a `ProtocolError` (`400`) says the same.
 */
export class RequestRejectedError extends Error {
  constructor(
    /** The §9 status code, 400–599. */
    public readonly code: number,
    /** The description the caller sees in `Nats-Service-Error`. */
    public readonly description: string,
  ) {
    if (!Number.isInteger(code) || code < 400 || code > 599) {
      throw new RangeError(`RequestRejectedError: code must be an integer in 400–599, got ${code}`);
    }
    super(`request rejected (${code}): ${description}`);
    this.name = "RequestRejectedError";
  }
}

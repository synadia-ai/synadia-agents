// Mid-stream query reply per spec §7.2.
//
// The agent pauses its response stream with a `query` chunk and a fresh
// `reply_subject`. The caller publishes exactly one message to that subject
// (plain text OR JSON envelope, §5.1). No acknowledgment is defined.
//
// We expose the reply as `queryEvent.reply(answer)` on the yielded
// `StreamMessage`. A second call throws {@link QueryAlreadyRepliedError}.

import type { NatsConnection } from "@nats-io/nats-core";
import { NatsAgentError } from "../errors.js";
import { encodeEnvelope, type RequestEnvelope } from "../prompt/envelope.js";
import type { DecodedAttachment } from "../stream/chunk-decoder.js";

export class QueryAlreadyRepliedError extends NatsAgentError {
  constructor(public readonly id: string) {
    super(`query "${id}" has already been replied to`);
    this.name = "QueryAlreadyRepliedError";
  }
}

export interface QueryEvent {
  readonly type: "query";
  readonly id: string;
  readonly prompt: string;
  readonly attachments?: ReadonlyArray<DecodedAttachment>;
  /**
   * Publish the reply. Accepts plain text (shorthand per §5.1) or a JSON
   * envelope with at least `prompt` set. Fire-and-forget: resolves once the
   * message is flushed to the server; no ack from the agent is defined.
   *
   * Throws {@link QueryAlreadyRepliedError} on a second call.
   */
  reply(answer: string | RequestEnvelope): Promise<void>;
}

interface RawQuery {
  readonly id: string;
  readonly replySubject: string;
  readonly prompt: string;
  readonly attachments?: ReadonlyArray<DecodedAttachment>;
}

export function buildQueryEvent(nc: NatsConnection, raw: RawQuery): QueryEvent {
  let replied = false;
  const reply = async (answer: string | RequestEnvelope): Promise<void> => {
    if (replied) throw new QueryAlreadyRepliedError(raw.id);
    replied = true;
    const payload =
      typeof answer === "string" ? new TextEncoder().encode(answer) : encodeEnvelope(answer);
    nc.publish(raw.replySubject, payload);
    await nc.flush();
  };
  return Object.freeze({
    type: "query" as const,
    id: raw.id,
    prompt: raw.prompt,
    ...(raw.attachments !== undefined ? { attachments: raw.attachments } : {}),
    reply,
  });
}

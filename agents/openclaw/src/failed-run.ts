// OpenClaw's reply to a failed run carries `isError: true`; its text says
// the run failed and names no raw provider text. The inbound helper the
// gateway dispatches through rebuilds every payload before it reaches the
// channel's `deliver`, and drops `isError` on the way; `channelData`
// survives. OpenClaw still shows `isError` to the channel's own
// `messaging.transformReplyPayload`, so the transform copies the mark into
// `channelData.nats`, and `deliver` reads it there.

/** The fields of a reply payload the mark reads and writes. */
export interface MarkablePayload {
  readonly isError?: boolean;
  readonly channelData?: Record<string, unknown>;
}

/**
 * The channel's `transformReplyPayload`: a payload OpenClaw marked as an
 * error gains `channelData.nats.isError`, the rest of `channelData` kept;
 * any other payload is returned as it is. Never `null`, which would
 * suppress the reply.
 */
export function markFailedRunReply<P extends MarkablePayload>(payload: P): P {
  if (payload.isError !== true) return payload;
  const nats = payload.channelData?.nats;
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      nats: { ...(isRecord(nats) ? nats : {}), isError: true },
    },
  };
}

/** Whether a payload `deliver` got carries the mark the transform set. */
export function isFailedRunReply(payload: {
  readonly channelData?: Record<string, unknown>;
}): boolean {
  const nats = payload.channelData?.nats;
  return isRecord(nats) && nats.isError === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

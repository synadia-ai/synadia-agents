// Pure: stream-termination and error-signal detection per §6.5, §9.3.
//
// A terminator is "a zero-byte body message carrying no NATS headers". An
// error-headered message with empty body is NOT a terminator — it's the
// error signal, and the actual terminator follows it (§9.3).

export interface MsgLike {
  readonly data: Uint8Array;
  readonly headers?: unknown;
}

/** True iff `msg` is the empty-body, headerless stream terminator (§6.5). */
export function isTerminator(msg: MsgLike): boolean {
  return msg.data.length === 0 && !msg.headers;
}

/** True iff `msg` carries service-error headers (§9.1). */
export function isErrorSignal(msg: MsgLike): boolean {
  const h = msg.headers as
    { get?: (k: string) => string; has?: (k: string) => boolean } | undefined;
  if (!h) return false;
  if (typeof h.has === "function") return h.has("Nats-Service-Error-Code");
  if (typeof h.get === "function") {
    try {
      return (h.get("Nats-Service-Error-Code") ?? "") !== "";
    } catch {
      return false;
    }
  }
  return false;
}

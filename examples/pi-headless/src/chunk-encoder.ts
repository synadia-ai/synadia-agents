// Typed-chunk helpers for the response wire (§6).
//
// Every non-terminating chunk is `{"type": "...", "data": ...}`; the
// stream ends with an empty-body no-headers message (§6.5). Errors are
// sent via NATS micro service error headers by the framework
// (`msg.respondError`) — they don't live in this module.

const encoder = new TextEncoder();

function encodeChunk(type: string, data: unknown): Uint8Array {
  return encoder.encode(JSON.stringify({ type, data }));
}

/** §6.4 — request accepted, work in progress; resets caller inactivity timeout. */
export function statusAck(): Uint8Array {
  return encodeChunk("status", "ack");
}

/** Arbitrary status token (SDK callers tolerate unrecognized values). */
export function status(token: string): Uint8Array {
  return encodeChunk("status", token);
}

/** §6.3 — a piece of response text. Multiple `response` chunks concatenate. */
export function responseText(text: string): Uint8Array {
  return encodeChunk("response", text);
}

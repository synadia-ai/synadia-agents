// Typed-chunk helpers for the v0.2.0-draft response wire (§6).
//
// Every non-terminating chunk is `{"type": "...", "data": ...}`; the
// stream ends with an empty-body no-headers message (§6.5). Errors are
// sent via NATS micro service error headers by the framework
// (`msg.respondError`) — they don't live in this module.
//
// In addition to the protocol-standard `status` / `response` / `query`
// chunks, we encode tool-call observability as **status chunks with a
// structured prefix in the data string** (`tool_use:<json>` and
// `tool_result:<json>`). This keeps the wire spec-compliant — `status.data`
// is a string per §6.4 — while letting our bridge translate the prefix
// into a richer UI event for the web client. SDK callers that don't know
// the prefix just see them as opaque status tokens.

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

/**
 * §7 — interactive query. The agent emits this and listens on `replySubject`
 * for a single text reply. Used here to surface SDK `canUseTool` permission
 * requests so the human caller can approve/deny each tool in flight.
 */
export function queryChunk(id: string, replySubject: string, prompt: string): Uint8Array {
  return encodeChunk("query", { id, reply_subject: replySubject, prompt });
}

/**
 * Tool-call observability: a status chunk whose data string is
 * `tool_use:<json>`. The bridge detects the prefix and re-emits as a
 * structured server message; raw SDK callers see it as an opaque token.
 *
 * Inputs are bounded the same way `tool_result` outputs are — a Write/Bash
 * call with a large argument would otherwise blow past the session's
 * `max_payload` and the chunk would silently drop. When the serialised form
 * exceeds the cap, swap `input` for a truncation marker that preserves the
 * record shape so the bridge's parsing stays uniform.
 */
export function toolUseStatus(
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
): Uint8Array {
  const inputJson = JSON.stringify(input);
  let safeInput: Record<string, unknown> = input;
  if (inputJson.length > 4_000) {
    safeInput = {
      _truncated: true,
      _original_size_bytes: inputJson.length,
      _preview: inputJson.slice(0, 1_000) + "…[truncated]",
    };
  }
  const payload = JSON.stringify({ id: toolUseId, name, input: safeInput });
  return encodeChunk("status", `tool_use:${payload}`);
}

/**
 * Tool-result observability: a status chunk whose data string is
 * `tool_result:<json>`. The output is truncated to keep the chunk small
 * (a giant `cat` result would otherwise blow through max_payload).
 */
export function toolResultStatus(
  toolUseId: string,
  output: string,
  isError: boolean,
): Uint8Array {
  const truncated = output.length > 4_000 ? output.slice(0, 4_000) + "…[truncated]" : output;
  const payload = JSON.stringify({
    tool_use_id: toolUseId,
    output: truncated,
    is_error: isError,
  });
  return encodeChunk("status", `tool_result:${payload}`);
}

/**
 * Cost notification: emitted after each turn completes with the per-turn
 * and cumulative cost, so the UI can keep a running tally per session.
 */
export function costStatus(turnCostUsd: number, totalCostUsd: number): Uint8Array {
  const payload = JSON.stringify({
    turn_cost_usd: turnCostUsd,
    total_cost_usd: totalCostUsd,
  });
  return encodeChunk("status", `cost:${payload}`);
}

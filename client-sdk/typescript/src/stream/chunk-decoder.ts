// Pure: decode a single wire chunk per spec §6.2 into a typed
// {@link DecodedChunk}. Unknown `type` values return `null` — callers MUST
// silently drop them per §6.6.
//
// Two decoded shapes deliberately skip the `reply()` method on `query`:
// that method is tied to the NATS connection and is added by the shell
// (PromptStream) before the event is yielded to the application.

import { ProtocolError } from "../errors.js";

export interface DecodedResponse {
  readonly type: "response";
  readonly text: string;
  readonly attachments?: ReadonlyArray<DecodedAttachment>;
}

export interface DecodedStatus {
  readonly type: "status";
  readonly status: string;
}

export interface DecodedQuery {
  readonly type: "query";
  readonly id: string;
  readonly replySubject: string;
  readonly prompt: string;
  readonly attachments?: ReadonlyArray<DecodedAttachment>;
}

export interface DecodedAttachment {
  readonly filename: string;
  /** Raw base64 content as it arrived on the wire — decoding is the caller's choice. */
  readonly content: string;
}

export type DecodedChunk = DecodedResponse | DecodedStatus | DecodedQuery;

/**
 * Parse a chunk body (the raw bytes NATS delivered as `msg.data`) into a
 * typed {@link DecodedChunk}.
 *
 * Returns `null` for an unknown `type` — callers drop and continue (§6.6).
 * Throws {@link ProtocolError} for malformed JSON or a malformed recognized
 * shape (e.g. a `response` chunk without text).
 */
export function decodeChunk(bytes: Uint8Array): DecodedChunk | null {
  const text = new TextDecoder().decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ProtocolError(`chunk body is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProtocolError("chunk body must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const type = obj["type"];
  if (typeof type !== "string") {
    throw new ProtocolError("chunk body missing string `type` field");
  }
  const data = obj["data"];
  switch (type) {
    case "response":
      return decodeResponseChunk(data);
    case "status":
      return decodeStatusChunk(data);
    case "query":
      return decodeQueryChunk(data);
    default:
      return null; // §6.6 — silently drop unknown types
  }
}

function decodeResponseChunk(data: unknown): DecodedResponse {
  // Bare-string shorthand: `data` is the response text (§6.3).
  if (typeof data === "string") {
    return { type: "response", text: data };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ProtocolError("`response` chunk `data` must be a string or object");
  }
  const obj = data as Record<string, unknown>;
  const text = obj["text"];
  if (typeof text !== "string") {
    throw new ProtocolError("`response` chunk `data.text` must be a string");
  }
  const attachments = decodeAttachments(obj["attachments"], "response");
  if (attachments !== undefined) {
    return { type: "response", text, attachments };
  }
  return { type: "response", text };
}

function decodeStatusChunk(data: unknown): DecodedStatus {
  if (typeof data !== "string") {
    throw new ProtocolError("`status` chunk `data` must be a string");
  }
  return { type: "status", status: data };
}

function decodeQueryChunk(data: unknown): DecodedQuery {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ProtocolError("`query` chunk `data` must be an object");
  }
  const obj = data as Record<string, unknown>;
  const id = obj["id"];
  const replySubject = obj["reply_subject"];
  const prompt = obj["prompt"];
  if (typeof id !== "string") throw new ProtocolError("`query` chunk missing string `id`");
  if (typeof replySubject !== "string")
    throw new ProtocolError("`query` chunk missing string `reply_subject`");
  if (typeof prompt !== "string") throw new ProtocolError("`query` chunk missing string `prompt`");
  const attachments = decodeAttachments(obj["attachments"], "query");
  if (attachments !== undefined) {
    return { type: "query", id, replySubject, prompt, attachments };
  }
  return { type: "query", id, replySubject, prompt };
}

function decodeAttachments(
  raw: unknown,
  ctx: string,
): ReadonlyArray<DecodedAttachment> | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ProtocolError(`\`${ctx}\` chunk \`attachments\` must be an array`);
  }
  return raw.map((item, idx) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ProtocolError(`\`${ctx}\` chunk attachment #${idx} must be an object`);
    }
    const o = item as Record<string, unknown>;
    if (typeof o["filename"] !== "string") {
      throw new ProtocolError(`\`${ctx}\` chunk attachment #${idx} missing string \`filename\``);
    }
    if (typeof o["content"] !== "string") {
      throw new ProtocolError(`\`${ctx}\` chunk attachment #${idx} missing string \`content\``);
    }
    return { filename: o["filename"], content: o["content"] };
  });
}

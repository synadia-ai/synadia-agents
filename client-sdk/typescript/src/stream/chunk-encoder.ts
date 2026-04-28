// Pure: encode a typed chunk to wire JSON bytes per spec §6.2/§6.3/§7.
//
// Mirror of {@link "./chunk-decoder.ts"} for the agent (server) side. Used
// by {@link "../service.ts" AgentService} to push chunks back to a caller's
// reply inbox via `request.respond(...)`.
//
// Wire shapes (all `{type, data}`):
//   - response: `{type:"response", data: <text>}` — bare-string shorthand (§6.3)
//                or `{type:"response", data:{text, attachments?}}` for richer payloads.
//   - status:   `{type:"status",   data: <status string>}` (§6.4)
//   - query:    `{type:"query",    data:{id, reply_subject, prompt, attachments?}}` (§7)

import type { DecodedAttachment } from "./chunk-decoder.js";

export interface ResponseChunk {
  readonly type: "response";
  readonly text: string;
  readonly attachments?: ReadonlyArray<DecodedAttachment>;
}

export interface StatusChunk {
  readonly type: "status";
  readonly status: string;
}

export interface QueryChunk {
  readonly type: "query";
  readonly id: string;
  readonly replySubject: string;
  readonly prompt: string;
  readonly attachments?: ReadonlyArray<DecodedAttachment>;
}

export type Chunk = ResponseChunk | StatusChunk | QueryChunk;

/**
 * Encode a typed {@link Chunk} into wire-shape JSON bytes.
 *
 * `response` chunks without attachments use the bare-string shorthand
 * (§6.3). With attachments, the richer object form is emitted so the
 * caller's chunk-decoder can pick them up.
 */
export function encodeChunk(chunk: Chunk): Uint8Array {
  let body: Record<string, unknown>;
  switch (chunk.type) {
    case "response":
      body = encodeResponse(chunk);
      break;
    case "status":
      body = { type: "status", data: chunk.status };
      break;
    case "query":
      body = encodeQuery(chunk);
      break;
  }
  return new TextEncoder().encode(JSON.stringify(body));
}

function encodeResponse(chunk: ResponseChunk): Record<string, unknown> {
  if (chunk.attachments === undefined || chunk.attachments.length === 0) {
    // §6.3 bare-string shorthand.
    return { type: "response", data: chunk.text };
  }
  return {
    type: "response",
    data: {
      text: chunk.text,
      attachments: chunk.attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
      })),
    },
  };
}

function encodeQuery(chunk: QueryChunk): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: chunk.id,
    reply_subject: chunk.replySubject,
    prompt: chunk.prompt,
  };
  if (chunk.attachments !== undefined && chunk.attachments.length > 0) {
    data["attachments"] = chunk.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
    }));
  }
  return { type: "query", data };
}

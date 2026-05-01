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

import type { DecodedAttachment } from "@synadia-ai/agents";

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

/**
 * UTF-8-safe split for a long response text into substrings small enough
 * to ship as `{type:"response", data:<slice>}` chunks under a given
 * NATS `max_payload`.
 *
 * Iterates by code-point so a multi-byte UTF-8 sequence or a UTF-16
 * surrogate pair is never split mid-character. The per-slice budget
 * is `(maxPayloadBytes - reserveBytes) / safetyDivisor`.
 *
 * **`safetyDivisor` selection.** The default `safetyDivisor = 2` is sized
 * for natural-language text where JSON escaping is rare (typical LLM
 * output: a handful of `"` / `\\` per chunk, ~1% expansion). It is **not**
 * worst-case-safe: a string of ASCII control characters where every byte
 * rewrites to `\uXXXX` (6 chars) can produce a JSON-encoded chunk up to
 * ~3× `maxPayloadBytes`. Callers feeding arbitrary binary-ish content,
 * mixed-encoding strings, or a high control-character density should pass
 * `safetyDivisor: 6` (or higher) to guarantee the encoded chunk stays
 * under `maxPayloadBytes` even under worst-case escaping.
 *
 * Designed to replace the identical `splitTextForChunks` /
 * `publishResponseText` chunkers carried by the `agents/{claude-code,
 * openclaw, pi}` harnesses.
 */
export function splitResponseText(
  text: string,
  maxPayloadBytes: number,
  opts: { reserveBytes?: number; safetyDivisor?: number } = {},
): string[] {
  // 32 covers `{"type":"response","data":""}` (28 chars) plus a small margin.
  const reserve = opts.reserveBytes ?? 32;
  const safetyDivisor = opts.safetyDivisor ?? 2;
  const budget = Math.max(64, Math.floor((maxPayloadBytes - reserve) / safetyDivisor));

  if (text.length === 0) return [];
  const out: string[] = [];
  const encoder = new TextEncoder();
  let buf = "";
  let bufBytes = 0;

  for (const cp of text) {
    const cpBytes = encoder.encode(cp).byteLength;
    if (bufBytes + cpBytes > budget && buf.length > 0) {
      out.push(buf);
      buf = "";
      bufBytes = 0;
    }
    buf += cp;
    bufBytes += cpBytes;
  }
  if (buf.length > 0) out.push(buf);
  return out;
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

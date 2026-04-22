// Pure: request-envelope construction for the prompt endpoint (§5.1).
//
// Programmatic callers always emit the JSON form — the plain-text shorthand
// is a CLI convenience we don't need. Attachments are base64-encoded per
// RFC 4648 §4 (standard alphabet, padded, no URL-safe, no whitespace).
//
// Stays runtime-agnostic (no Buffer, no fs) so a future browser/WS build
// can depend on this module unchanged.

import { utf8ByteLength } from "../bytes.js";

export interface RequestAttachment {
  readonly filename: string;
  readonly content: Uint8Array;
}

export interface RequestEnvelope {
  readonly prompt: string;
  readonly attachments?: ReadonlyArray<RequestAttachment>;
}

/** Serialize a request envelope to UTF-8 bytes per §5.1. */
export function encodeEnvelope(env: RequestEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelopeObject(env)));
}

/** UTF-8 byte length of the serialized envelope — used by the `max_payload` check (§5.4). */
export function encodedEnvelopeSize(env: RequestEnvelope): number {
  return utf8ByteLength(JSON.stringify(envelopeObject(env)));
}

function envelopeObject(env: RequestEnvelope): Record<string, unknown> {
  const obj: Record<string, unknown> = { prompt: env.prompt };
  if (env.attachments && env.attachments.length > 0) {
    obj["attachments"] = env.attachments.map((a) => ({
      filename: a.filename,
      content: encodeBase64(a.content),
    }));
  }
  return obj;
}

// ---------------------------------------------------------------------------
// RFC 4648 §4 base64 (standard alphabet, padded). Deliberately hand-rolled
// so this module stays free of runtime-specific APIs (Buffer / btoa).
// ---------------------------------------------------------------------------

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  let i = 0;
  for (; i + 3 <= len; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    out += BASE64_ALPHABET[b0 >> 2]!;
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]!;
    out += BASE64_ALPHABET[b2 & 0x3f]!;
  }
  const remaining = len - i;
  if (remaining === 1) {
    const b0 = bytes[i]!;
    out += BASE64_ALPHABET[b0 >> 2]!;
    out += BASE64_ALPHABET[(b0 & 0x03) << 4]!;
    out += "==";
  } else if (remaining === 2) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    out += BASE64_ALPHABET[b0 >> 2]!;
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += BASE64_ALPHABET[(b1 & 0x0f) << 2]!;
    out += "=";
  }
  return out;
}

/** Decode standard-alphabet padded base64 back to bytes. Tolerant of no-padding. */
export function decodeBase64(s: string): Uint8Array {
  // Map char → 6-bit value; '=' → sentinel.
  const lookup = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    lookup[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  // Count padding.
  let padding = 0;
  if (s.endsWith("==")) padding = 2;
  else if (s.endsWith("=")) padding = 1;
  const clean = padding > 0 ? s.slice(0, -padding) : s;
  const outLen = Math.floor((clean.length * 6) / 8);
  const out = new Uint8Array(outLen);
  let outIdx = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if (code >= 128) throw new Error("invalid base64 character");
    const val = lookup[code];
    if (val === -1 || val === undefined) {
      throw new Error(`invalid base64 character at position ${i}`);
    }
    buf = (buf << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIdx++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

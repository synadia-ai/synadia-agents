// Pure: request-envelope construction for the prompt endpoint (§5.1).
//
// Programmatic callers always emit the JSON form — the plain-text shorthand
// is a CLI convenience we don't need. Attachments are base64-encoded per
// RFC 4648 §4 (standard alphabet, padded, no URL-safe, no whitespace).
//
// Stays runtime-agnostic (no Buffer, no fs) so a future browser/WS build
// can depend on this module unchanged.

import { utf8ByteLength } from "../bytes.js";
import { ProtocolError } from "../errors.js";

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

// ---------------------------------------------------------------------------
// Agent-side decode (§5.1, §5.2, §5.3) — bytes coming off the wire into a
// validated, base64-decoded {@link RequestEnvelope}. Used by `AgentService`
// to surface a clean envelope to the prompt handler without each agent
// harness re-implementing the same rules.
// ---------------------------------------------------------------------------

/**
 * Decode an inbound prompt envelope from raw NATS message bytes, following
 * the §5.3 discrimination algorithm exactly:
 *
 *  1. A zero-byte payload is invalid.
 *  2. If the first non-whitespace byte is `{`, the payload is a JSON envelope
 *     and MUST parse as one — a parse failure (or a missing `prompt` string
 *     field) is a hard error, NOT a fall-through to plain text.
 *  3. Otherwise it is the plain-text shorthand: the whole payload is the
 *     `prompt`.
 *
 * An envelope-shaped object is decoded with §5.2 base64 + filename validation
 * on attachments. This mirrors the Python SDK's `looks_like_json`
 * discrimination so the two decoders agree on the wire (interop).
 *
 * Throws {@link ProtocolError} for: a zero-byte payload, a `{`-led payload
 * that is not well-formed JSON, missing/non-string/empty `prompt`, invalid
 * `attachments` shape, non-strict base64 (URL-safe, unpadded, whitespace),
 * or unsafe filenames (path separators, `..`, NUL, absolute paths). Agent
 * services translate this into a `Nats-Service-Error-Code: 400` response.
 */
export function decodeEnvelope(data: Uint8Array): RequestEnvelope {
  // §5.3: a zero-byte request payload is invalid.
  if (data.length === 0) {
    throw new ProtocolError("zero-byte request payload (§5.3)");
  }

  const text = new TextDecoder().decode(data);

  // §5.3 discrimination: only a `{`-led payload is a JSON envelope. Anything
  // else — including a leading digit, `[`, or quote — is the plain-text
  // shorthand and the whole payload becomes the prompt verbatim.
  if (!startsWithJsonObject(text)) {
    return { prompt: text };
  }

  // §5.3 step 2: the payload committed to JSON by its leading `{`, so a parse
  // failure is a malformed envelope (400), not plain text.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProtocolError(`malformed JSON envelope: ${(err as Error).message}`);
  }

  // A leading `{` can only parse to an object; this guard is defensive.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProtocolError("envelope must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  const prompt = obj["prompt"];
  if (typeof prompt !== "string") {
    throw new ProtocolError("envelope missing required string `prompt` field");
  }
  if (prompt.length === 0) {
    // §5.1: an envelope's `prompt` field is required to be non-empty.
    // Matches the behaviour of the hand-rolled decoders in
    // `agents/{pi,claude-code,openclaw}/`, which all return 400 on empty.
    throw new ProtocolError("envelope `prompt` must be a non-empty string");
  }

  const rawAttachments = obj["attachments"];
  if (rawAttachments === undefined) {
    return { prompt };
  }
  if (!Array.isArray(rawAttachments)) {
    throw new ProtocolError("envelope `attachments` must be an array");
  }

  const attachments: RequestAttachment[] = rawAttachments.map((item, idx) =>
    decodeAttachment(item, idx),
  );
  return attachments.length > 0 ? { prompt, attachments } : { prompt };
}

/**
 * §5.3 discrimination predicate: `true` iff the first non-whitespace byte is
 * `{`, marking the payload as a JSON envelope rather than the plain-text
 * shorthand. Only ASCII whitespace (`0x09`, `0x0A`, `0x0D`, `0x20`) is
 * skipped, per the spec. An empty or all-whitespace payload is not JSON
 * (zero-byte is rejected separately by the caller).
 *
 * Mirrors the Python SDK's `looks_like_json` (`agents/envelope.py`) so both
 * decoders classify the same bytes the same way.
 */
function startsWithJsonObject(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20) continue;
    return c === 0x7b; // '{'
  }
  return false;
}

function decodeAttachment(item: unknown, idx: number): RequestAttachment {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new ProtocolError(`attachment[${idx}] must be an object`);
  }
  const o = item as Record<string, unknown>;
  const filename = o["filename"];
  const content = o["content"];
  if (typeof filename !== "string") {
    throw new ProtocolError(`attachment[${idx}] missing string \`filename\``);
  }
  if (typeof content !== "string") {
    throw new ProtocolError(`attachment[${idx}] missing string \`content\``);
  }
  assertSafeFilename(filename, idx);
  let bytes: Uint8Array;
  try {
    bytes = decodeStrictBase64(content);
  } catch (err) {
    throw new ProtocolError(
      `attachment[${idx}] has invalid base64 content: ${(err as Error).message}`,
    );
  }
  return { filename, content: bytes };
}

const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * RFC 4648 §4 base64: standard alphabet, padded, no URL-safe, no whitespace.
 *
 * `decodeBase64` is tolerant; this wrapper rejects the relaxations the spec
 * forbids on the wire (§5.2) so agents reject non-compliant peers rather
 * than silently decoding garbage.
 */
export function decodeStrictBase64(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  if (s.length % 4 !== 0) {
    throw new Error("base64 length must be a multiple of 4 (padded)");
  }
  if (!STRICT_BASE64_RE.test(s)) {
    throw new Error("base64 must use standard alphabet, padded, no whitespace");
  }
  return decodeBase64(s);
}

const FILENAME_FORBIDDEN_RE = /[/\\\0]/;

function assertSafeFilename(name: string, idx: number): void {
  if (name.length === 0) {
    throw new ProtocolError(`attachment[${idx}] has empty filename`);
  }
  if (FILENAME_FORBIDDEN_RE.test(name)) {
    throw new ProtocolError(`attachment[${idx}] has unsafe filename (path separator or NUL)`);
  }
  if (name === "." || name === ".." || name.startsWith("../") || name.startsWith("./")) {
    throw new ProtocolError(`attachment[${idx}] has unsafe filename ('.' or '..' component)`);
  }
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

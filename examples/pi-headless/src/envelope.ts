// Request envelope parser per protocol §5.
//
// The spec says: plain UTF-8 text is shorthand for { prompt: <text> }; a
// payload beginning with `{` (after stripping leading whitespace) MUST be
// parsed as JSON and MUST include a non-empty `prompt` string. A zero-byte
// request is invalid.

export interface ParsedEnvelope {
  readonly prompt: string;
  readonly attachments?: ReadonlyArray<ParsedAttachment>;
}

export interface ParsedAttachment {
  readonly filename: string;
  /** RFC 4648 §4 base64, as received on the wire. */
  readonly base64: string;
}

export class EnvelopeError extends Error {
  constructor(
    public readonly code: 400,
    message: string,
  ) {
    super(message);
    this.name = "EnvelopeError";
  }
}

const WHITESPACE = new Set([0x09, 0x0a, 0x0d, 0x20]);

function firstNonWhitespaceByte(bytes: Uint8Array): number | undefined {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === undefined) return undefined;
    if (!WHITESPACE.has(b)) return b;
  }
  return undefined;
}

/** Parse the raw request body. Throws EnvelopeError on §5.3 violations. */
export function parseEnvelope(data: Uint8Array): ParsedEnvelope {
  if (data.length === 0) {
    throw new EnvelopeError(400, "empty payload");
  }

  const first = firstNonWhitespaceByte(data);
  if (first === undefined) {
    throw new EnvelopeError(400, "whitespace-only payload");
  }

  // Plain-text shorthand.
  if (first !== 0x7b /* `{` */) {
    const text = new TextDecoder().decode(data);
    if (text.length === 0) throw new EnvelopeError(400, "empty plain-text payload");
    return { prompt: text };
  }

  // JSON form.
  const raw = new TextDecoder().decode(data);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new EnvelopeError(400, `invalid JSON envelope: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EnvelopeError(400, "envelope must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const prompt = obj["prompt"];
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new EnvelopeError(400, "envelope.prompt must be a non-empty string");
  }
  const attachmentsIn = obj["attachments"];
  if (attachmentsIn === undefined) {
    return { prompt };
  }
  if (!Array.isArray(attachmentsIn)) {
    throw new EnvelopeError(400, "envelope.attachments must be an array");
  }
  const attachments: ParsedAttachment[] = [];
  for (const [i, raw] of attachmentsIn.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new EnvelopeError(400, `attachments[${i}] must be an object`);
    }
    const a = raw as Record<string, unknown>;
    const filename = a["filename"];
    const content = a["content"];
    if (typeof filename !== "string" || filename.length === 0) {
      throw new EnvelopeError(400, `attachments[${i}].filename must be a non-empty string`);
    }
    if (typeof content !== "string" || content.length === 0) {
      throw new EnvelopeError(400, `attachments[${i}].content must be a non-empty base64 string`);
    }
    attachments.push({ filename, base64: content });
  }
  return { prompt, ...(attachments.length > 0 ? { attachments } : {}) };
}

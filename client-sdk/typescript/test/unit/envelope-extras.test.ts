// §5.6: top-level envelope fields the protocol does not define. The encoder
// writes `RequestEnvelope.extras` next to the protocol's own fields; the
// decoder keeps every field it does not know in `extras`.

import { describe, expect, it } from "vitest";
import {
  decodeEnvelope,
  encodedEnvelopeSize,
  encodeEnvelope,
  isEnvelopeField,
  type RequestEnvelope,
} from "../../src/prompt/envelope.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function wire(env: RequestEnvelope): Record<string, unknown> {
  return JSON.parse(dec.decode(encodeEnvelope(env))) as Record<string, unknown>;
}

describe("envelope extras (§5.6)", () => {
  it("encodes extras as top-level fields next to the protocol's", () => {
    const env: RequestEnvelope = {
      prompt: "hi",
      extras: { a: 1, nested: { b: [true, null] }, text: "x" },
    };
    expect(wire(env)).toEqual({ prompt: "hi", a: 1, nested: { b: [true, null] }, text: "x" });
    expect(encodedEnvelopeSize(env)).toBe(encodeEnvelope(env).length);
  });

  it("lets the protocol's fields win a clash, and skips undefined values", () => {
    const env: RequestEnvelope = {
      prompt: "real",
      extras: { prompt: "forged", attachments: "forged", gone: undefined, kept: 0 },
    };
    expect(wire(env)).toEqual({ prompt: "real", kept: 0 });
  });

  it("decodes every unknown field into extras, verbatim", () => {
    const decoded = decodeEnvelope(
      enc.encode(JSON.stringify({ prompt: "hi", a: 1, obj: { k: "v" }, nil: null })),
    );
    expect(decoded).toEqual({ prompt: "hi", extras: { a: 1, obj: { k: "v" }, nil: null } });
    expect(Object.isFrozen(decoded.extras)).toBe(true);
  });

  it("decodes a plain envelope with no extras key at all", () => {
    const decoded = decodeEnvelope(enc.encode(JSON.stringify({ prompt: "hi" })));
    expect(decoded).toStrictEqual({ prompt: "hi" });
    expect("extras" in decodeEnvelope(enc.encode("plain text"))).toBe(false);
  });

  it("keeps a field named __proto__ as data, both ways", () => {
    const decoded = decodeEnvelope(enc.encode('{"prompt":"hi","__proto__":{"polluted":true}}'));
    expect(Object.keys(decoded.extras ?? {})).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(dec.decode(encodeEnvelope(decoded))).toBe(
      '{"prompt":"hi","__proto__":{"polluted":true}}',
    );
  });

  it("round-trips: decode then encode preserves the unknown fields", () => {
    const original = '{"prompt":"hi","x_ext":{"id":"7"},"flag":false}';
    expect(dec.decode(encodeEnvelope(decodeEnvelope(enc.encode(original))))).toBe(original);
  });

  it("names the fields the codec owns", () => {
    expect(isEnvelopeField("prompt")).toBe(true);
    expect(isEnvelopeField("attachments")).toBe(true);
    expect(isEnvelopeField("anything_else")).toBe(false);
  });
});

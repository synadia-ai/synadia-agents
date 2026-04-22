import { describe, expect, it } from "vitest";
import { encodeEnvelope, encodedEnvelopeSize } from "../../src/prompt/envelope.js";

describe("envelope", () => {
  it("encodes the prompt as a JSON envelope", () => {
    const bytes = encodeEnvelope({ prompt: "hello" });
    expect(new TextDecoder().decode(bytes)).toBe('{"prompt":"hello"}');
  });

  it("encodedEnvelopeSize matches encoded byte length", () => {
    const env = { prompt: "describe this photo" };
    expect(encodedEnvelopeSize(env)).toBe(encodeEnvelope(env).byteLength);
  });

  it("handles multi-byte UTF-8 correctly", () => {
    const env = { prompt: "résumé 中文 🙂" };
    const bytes = encodeEnvelope(env);
    // Size should match the UTF-8 byte length of the JSON-serialized form.
    expect(encodedEnvelopeSize(env)).toBe(bytes.byteLength);
    // Round-trips through decoding.
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { prompt: string };
    expect(parsed.prompt).toBe("résumé 中文 🙂");
  });
});

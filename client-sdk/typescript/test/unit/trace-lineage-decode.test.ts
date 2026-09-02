import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope } from "../../src/prompt/envelope.js";
import { ProtocolError } from "../../src/errors.js";

const enc = new TextEncoder();
const raw = (s: string): Uint8Array => enc.encode(s);
const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);

/**
 * Lineage is the SDK's tracing extension on top of v0.3. Both SDKs must
 * read it the same way: a wrongly typed value is a malformed envelope,
 * not a field to quietly ignore — dropping it makes the receiver mint a
 * fresh root and file the execution under a tree of its own.
 */
describe("envelope lineage decoding", () => {
  it("reads both fields", () => {
    const env = decodeEnvelope(raw(`{"prompt":"x","thread_id":"${THREAD}","root_id":"${ROOT}"}`));
    expect(env.threadId).toBe(THREAD);
    expect(env.rootId).toBe(ROOT);
  });

  it("treats absent and null alike", () => {
    expect(decodeEnvelope(raw('{"prompt":"x"}')).threadId).toBeUndefined();
    expect(decodeEnvelope(raw('{"prompt":"x","thread_id":null}')).threadId).toBeUndefined();
  });

  it("reads one field without the other", () => {
    const env = decodeEnvelope(raw(`{"prompt":"x","thread_id":"${THREAD}"}`));
    expect(env.threadId).toBe(THREAD);
    expect(env.rootId).toBeUndefined();
  });

  it.each([
    ["a number", '{"prompt":"x","thread_id":123}'],
    ["an object", '{"prompt":"x","thread_id":{}}'],
    ["an array", '{"prompt":"x","root_id":[]}'],
    ["a boolean", '{"prompt":"x","root_id":true}'],
  ])("rejects %s", (_label, body) => {
    expect(() => decodeEnvelope(raw(body))).toThrow(ProtocolError);
  });

  it("round-trips through encode", () => {
    const env = decodeEnvelope(encodeEnvelope({ prompt: "x", threadId: THREAD, rootId: ROOT }));
    expect(env).toEqual({ prompt: "x", threadId: THREAD, rootId: ROOT });
  });

  it("omits lineage entirely when untraced", () => {
    const bytes = encodeEnvelope({ prompt: "x" });
    expect(new TextDecoder().decode(bytes)).toBe('{"prompt":"x"}');
  });
});

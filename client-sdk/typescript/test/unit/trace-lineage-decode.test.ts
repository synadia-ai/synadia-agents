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

  it.each([
    ["absent", '{"prompt":"x"}'],
    ["null", '{"prompt":"x","thread_id":null}'],
    // An empty id names nothing, so the receiver must mint rather than
    // adopt "" and file every child under it. Python normalises the same
    // way, so the two SDKs read this wire alike.
    ["an empty string", '{"prompt":"x","thread_id":""}'],
  ])("treats %s as no lineage", (_label, body) => {
    expect(decodeEnvelope(raw(body)).threadId).toBeUndefined();
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

  /**
   * An adopted id is stamped verbatim on the agent's model requests as a
   * header value, so the receiver bounds it to the shape the SDKs mint —
   * otherwise a caller can inject a CRLF, or a megabyte, into headers the
   * harness sends to a third party.
   */
  it.each([
    ["uppercase hex", "A".repeat(32)],
    ["one character short", "a".repeat(31)],
    ["one character long", "a".repeat(33)],
    ["non-hex characters", "g".repeat(32)],
    ["a header injection", `${"a".repeat(30)}\r\nX-Injected: yes`],
    ["surrounding whitespace", ` ${"a".repeat(30)} `],
    ["a megabyte of garbage", "a".repeat(1 << 20)],
  ])("rejects %s as malformed", (_label, id) => {
    expect(() => decodeEnvelope(raw(JSON.stringify({ prompt: "x", thread_id: id })))).toThrow(
      ProtocolError,
    );
    expect(() => decodeEnvelope(raw(JSON.stringify({ prompt: "x", root_id: id })))).toThrow(
      ProtocolError,
    );
  });

  it("accepts exactly what the SDK mints", () => {
    const env = decodeEnvelope(raw(`{"prompt":"x","thread_id":"${THREAD}","root_id":"${ROOT}"}`));
    expect(env.threadId).toBe(THREAD);
    expect(env.rootId).toBe(ROOT);
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

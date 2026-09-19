import { describe, expect, it } from "vitest";
import { newAgentId } from "../../src/identity/agent-id.js";
import { buildEdgeRecord, TOOL_CALL_ID_MAX, validToolCallId } from "../../src/trace.js";

const THREAD = "a".repeat(32);
// `alice` from test-fixtures/identity/keys.json — any real user NKEY does.
const AGENT = newAgentId("ACME", "UCDUW5V44EBDBIK2FL4CTNDBQFNGBEZVJHSZGQVKRHASN4AV4IWPB5NT");

/**
 * Both SDKs label an edge with the tool call id a caller passes, and both
 * bound it the same way — in Unicode code points, not UTF-16 units — so a
 * mixed-language fleet accepts exactly the same ids. A lone surrogate has
 * no UTF-8 form and is rejected on both sides.
 */
describe("validToolCallId", () => {
  it("accepts an ordinary id", () => {
    expect(validToolCallId("call_1")).toBe(true);
    expect(validToolCallId("toolu_01A09q90qw90lq917835lq9")).toBe(true);
  });

  it("rejects an empty id", () => {
    expect(validToolCallId("")).toBe(false);
  });

  it("bounds the length at TOOL_CALL_ID_MAX code points", () => {
    expect(validToolCallId("a".repeat(TOOL_CALL_ID_MAX))).toBe(true);
    expect(validToolCallId("a".repeat(TOOL_CALL_ID_MAX + 1))).toBe(false);
  });

  it("counts an astral character as one, like Python's len()", () => {
    expect("🙂".length).toBe(2); // two UTF-16 units …
    expect(validToolCallId("🙂".repeat(TOOL_CALL_ID_MAX))).toBe(true); // … one code point
    expect(validToolCallId("🙂".repeat(TOOL_CALL_ID_MAX + 1))).toBe(false);
  });

  it("rejects a lone surrogate half", () => {
    expect(validToolCallId("\ud83d")).toBe(false);
    expect(validToolCallId("call_\ude42")).toBe(false);
    expect(validToolCallId("a\ud83db")).toBe(false);
  });
});

describe("buildEdgeRecord", () => {
  it("writes a non-ASCII tool call id raw, as Python does", () => {
    const { payload } = buildEdgeRecord(AGENT, THREAD, null, THREAD, "call_é🙂", 0);
    const text = new TextDecoder().decode(payload);
    expect(text).toContain('"tool_call_id":"call_é🙂"');
    expect(text).not.toContain("\\u");
  });

  it("names its writer in canonical {account}.{user} form", () => {
    const { payload } = buildEdgeRecord(AGENT, THREAD, null, THREAD, null, 0);
    const record = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    expect(record["agent"]).toBe(
      `ACME.${"UCDUW5V44EBDBIK2FL4CTNDBQFNGBEZVJHSZGQVKRHASN4AV4IWPB5NT"}`,
    );
    // The writer sits where the design's table puts it: after `ts`, before the ids.
    expect(Object.keys(record)).toEqual([
      "version",
      "kind",
      "record_id",
      "ts",
      "agent",
      "thread_id",
      "parent_id",
      "root_id",
      "tool_call_id",
      "turn_count_hint",
    ]);
  });
});

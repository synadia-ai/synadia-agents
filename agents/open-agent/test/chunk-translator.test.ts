// Unit tests for the UI-part → Chunk translator.

import { describe, expect, test } from "bun:test";

import { translatePart } from "../src/chunk-translator.js";

describe("translatePart", () => {
  test("text-delta becomes a response chunk", () => {
    const out = translatePart({ type: "text-delta", id: "t1", delta: "hello" });
    expect(out).toEqual([{ type: "response", text: "hello" }]);
  });

  test("empty text-delta is dropped", () => {
    const out = translatePart({ type: "text-delta", id: "t1", delta: "" });
    expect(out).toEqual([]);
  });

  test("tool-input-start announces the tool", () => {
    const out = translatePart({ type: "tool-input-start", toolCallId: "x", toolName: "bash" });
    expect(out).toEqual([{ type: "response", text: "\n[bash] " }]);
  });

  test("tool-input-available summarises bash input", () => {
    const out = translatePart({
      type: "tool-input-available",
      toolCallId: "x",
      toolName: "bash",
      input: { command: "ls -la" },
    });
    expect(out).toEqual([{ type: "response", text: "$ ls -la" }]);
  });

  test("tool-input-available summarises read input", () => {
    const out = translatePart({
      type: "tool-input-available",
      toolCallId: "x",
      toolName: "read",
      input: { filePath: "src/index.ts" },
    });
    expect(out).toEqual([{ type: "response", text: "read src/index.ts" }]);
  });

  test("tool-output-available summarises bash exit code and head", () => {
    const out = translatePart({
      type: "tool-output-available",
      toolCallId: "x",
      toolName: "bash",
      output: { exitCode: 0, stdout: "line1\nline2\n", stderr: "" },
    });
    expect(out).toEqual([
      { type: "response", text: "\nexit 0\nline1\nline2\n" },
    ]);
  });

  test("tool-output-available counts read lines", () => {
    const out = translatePart({
      type: "tool-output-available",
      toolCallId: "x",
      toolName: "read",
      output: { totalLines: 42 },
    });
    expect(out).toEqual([{ type: "response", text: "\n42 lines" }]);
  });

  test("tool-output-error renders an error tag", () => {
    const out = translatePart({
      type: "tool-output-error",
      toolCallId: "x",
      toolName: "bash",
      errorText: "permission denied",
    });
    expect(out).toEqual([
      { type: "response", text: "\n[bash error] permission denied" },
    ]);
  });

  test.each([
    "start",
    "start-step",
    "finish-step",
    "finish",
    "text-start",
    "text-end",
    "tool-input-delta",
    "error",
  ])("%s produces no chunks", (type) => {
    const out = translatePart({ type });
    expect(out).toEqual([]);
  });

  test("unknown part types are ignored (forward-compat)", () => {
    const out = translatePart({ type: "made-up-future-type", value: 1 });
    expect(out).toEqual([]);
  });

  test("default summariser truncates long JSON", () => {
    const out = translatePart({
      type: "tool-input-available",
      toolCallId: "x",
      toolName: "task",
      input: { description: "a".repeat(200) },
    });
    expect(out).toHaveLength(1);
    expect((out[0] as { text: string }).text.length).toBeLessThanOrEqual(80);
  });
});

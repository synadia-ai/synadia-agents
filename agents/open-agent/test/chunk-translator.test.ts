// Unit tests for the UI-part → Chunk translator.

import { describe, expect, test } from "bun:test";

import { translatePart } from "../src/chunk-translator.js";

/**
 * Helper — assert a chunk is a `tool_use:<json>` status and decode its
 * JSON payload.
 */
function decodeToolUse(chunk: unknown): { id: string; name: string; input: Record<string, unknown> } {
  const c = chunk as { type: string; status: string };
  expect(c.type).toBe("status");
  expect(c.status.startsWith("tool_use:")).toBe(true);
  return JSON.parse(c.status.slice("tool_use:".length));
}

function decodeToolResult(chunk: unknown): {
  tool_use_id: string;
  output: string;
  is_error: boolean;
} {
  const c = chunk as { type: string; status: string };
  expect(c.type).toBe("status");
  expect(c.status.startsWith("tool_result:")).toBe(true);
  return JSON.parse(c.status.slice("tool_result:".length));
}

describe("translatePart", () => {
  test("text-delta becomes a response chunk", () => {
    const out = translatePart({ type: "text-delta", id: "t1", delta: "hello" });
    expect(out).toEqual([{ type: "response", text: "hello" }]);
  });

  test("empty text-delta is dropped", () => {
    const out = translatePart({ type: "text-delta", id: "t1", delta: "" });
    expect(out).toEqual([]);
  });

  test("tool-input-start is silent — the tool_use status carries the announcement", () => {
    const out = translatePart({ type: "tool-input-start", toolCallId: "x", toolName: "bash" });
    expect(out).toEqual([]);
  });

  test("tool-input-available emits a tool_use status carrying id, name, and input verbatim", () => {
    const out = translatePart({
      type: "tool-input-available",
      toolCallId: "abc-123",
      toolName: "bash",
      input: { command: "ls -la", cwd: "src" },
    });
    expect(out).toHaveLength(1);
    const decoded = decodeToolUse(out[0]);
    expect(decoded).toEqual({
      id: "abc-123",
      name: "bash",
      input: { command: "ls -la", cwd: "src" },
    });
  });

  test("tool-input-available passes complex tool inputs through as JSON (no summarisation)", () => {
    const longDescription = "a".repeat(200);
    const out = translatePart({
      type: "tool-input-available",
      toolCallId: "x",
      toolName: "task",
      input: { description: longDescription, agent: "general-purpose" },
    });
    expect(out).toHaveLength(1);
    const decoded = decodeToolUse(out[0]);
    expect(decoded.input["description"]).toBe(longDescription);
    expect(decoded.input["agent"]).toBe("general-purpose");
  });

  test("tool-input-available with non-object input falls back to {}", () => {
    const out = translatePart({
      type: "tool-input-available",
      toolCallId: "x",
      toolName: "bash",
      input: "not-an-object",
    });
    expect(out).toHaveLength(1);
    const decoded = decodeToolUse(out[0]);
    expect(decoded.input).toEqual({});
  });

  test("tool-input-available without a toolCallId is dropped (would corrupt pairing)", () => {
    const out = translatePart({
      type: "tool-input-available",
      toolName: "bash",
      input: { command: "ls" },
    });
    expect(out).toEqual([]);
  });

  test("tool-output-available emits a tool_result status with summarised bash output", () => {
    const out = translatePart({
      type: "tool-output-available",
      toolCallId: "abc-123",
      toolName: "bash",
      output: { exitCode: 0, stdout: "line1\nline2\n", stderr: "" },
    });
    expect(out).toHaveLength(1);
    const decoded = decodeToolResult(out[0]);
    expect(decoded.tool_use_id).toBe("abc-123");
    expect(decoded.is_error).toBe(false);
    expect(decoded.output).toBe("exit 0\nline1\nline2\n");
  });

  test("tool-output-available preserves the read line count summary", () => {
    const out = translatePart({
      type: "tool-output-available",
      toolCallId: "x",
      toolName: "read",
      output: { totalLines: 42 },
    });
    expect(out).toHaveLength(1);
    const decoded = decodeToolResult(out[0]);
    expect(decoded.output).toBe("42 lines");
    expect(decoded.is_error).toBe(false);
  });

  test("tool-output-error emits a tool_result with is_error: true", () => {
    const out = translatePart({
      type: "tool-output-error",
      toolCallId: "abc-123",
      toolName: "bash",
      errorText: "permission denied",
    });
    expect(out).toHaveLength(1);
    const decoded = decodeToolResult(out[0]);
    expect(decoded).toEqual({
      tool_use_id: "abc-123",
      output: "permission denied",
      is_error: true,
    });
  });

  test("tool-output-error falls back to '(no message)' when no errorText is supplied", () => {
    const out = translatePart({
      type: "tool-output-error",
      toolCallId: "x",
      toolName: "bash",
    });
    expect(out).toHaveLength(1);
    const decoded = decodeToolResult(out[0]);
    expect(decoded.output).toBe("(no message)");
    expect(decoded.is_error).toBe(true);
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

  test("write tool_use elides the file content so a large body can't blow max_payload", () => {
    const bigBody = "x".repeat(64 * 1024);
    const out = translatePart({
      type: "tool-input-available",
      toolCallId: "x",
      toolName: "write",
      input: { filePath: "src/big.txt", content: bigBody },
    });
    const decoded = decodeToolUse(out[0]);
    expect(decoded.input["filePath"]).toBe("src/big.txt");
    expect(decoded.input["content"]).toBe(`<${bigBody.length} chars elided>`);
    // Whole status chunk is now small — well under the 1 MB default budget.
    const c = out[0] as { status: string };
    expect(c.status.length).toBeLessThan(2 * 1024);
  });

  test("edit tool_use elides both oldString and newString", () => {
    const oldBody = "a".repeat(8000);
    const newBody = "b".repeat(9000);
    const out = translatePart({
      type: "tool-input-available",
      toolCallId: "x",
      toolName: "edit",
      input: { filePath: "src/file.ts", oldString: oldBody, newString: newBody },
    });
    const decoded = decodeToolUse(out[0]);
    expect(decoded.input["filePath"]).toBe("src/file.ts");
    expect(decoded.input["oldString"]).toBe(`<${oldBody.length} chars elided>`);
    expect(decoded.input["newString"]).toBe(`<${newBody.length} chars elided>`);
  });

  test("write tool_use leaves small fields untouched", () => {
    const out = translatePart({
      type: "tool-input-available",
      toolCallId: "x",
      toolName: "write",
      input: { filePath: "tiny.txt", content: "hi" },
    });
    const decoded = decodeToolUse(out[0]);
    // Even a tiny content gets elided — `content` is always replaced because
    // the wire payload should never depend on caller's file size.
    expect(decoded.input["content"]).toBe("<2 chars elided>");
  });

  test("unknown tools have any large string field truncated by the default cap", () => {
    const giant = "z".repeat(50_000);
    const out = translatePart({
      type: "tool-input-available",
      toolCallId: "x",
      toolName: "future-tool",
      input: { command: giant, smallField: "ok" },
    });
    const decoded = decodeToolUse(out[0]);
    const command = decoded.input["command"] as string;
    expect(command.length).toBeLessThanOrEqual(1024);
    expect(command.endsWith("…")).toBe(true);
    expect(decoded.input["smallField"]).toBe("ok");
  });

  test("bash command is forwarded verbatim when under the cap", () => {
    const out = translatePart({
      type: "tool-input-available",
      toolCallId: "x",
      toolName: "bash",
      input: { command: "ls -la", cwd: "src" },
    });
    const decoded = decodeToolUse(out[0]);
    expect(decoded.input).toEqual({ command: "ls -la", cwd: "src" });
  });

  test("paired tool_use + tool_result share a stable tool_use_id", () => {
    const useChunks = translatePart({
      type: "tool-input-available",
      toolCallId: "shared-id-42",
      toolName: "grep",
      input: { pattern: "TODO" },
    });
    const resultChunks = translatePart({
      type: "tool-output-available",
      toolCallId: "shared-id-42",
      toolName: "grep",
      output: { matches: ["a.ts", "b.ts"] },
    });
    expect(decodeToolUse(useChunks[0]).id).toBe("shared-id-42");
    expect(decodeToolResult(resultChunks[0]).tool_use_id).toBe("shared-id-42");
  });
});

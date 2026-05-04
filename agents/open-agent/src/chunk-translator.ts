// AI SDK UI-message-part → NATS Agent Protocol chunk translation.
//
// The vendored open-agents `ToolLoopAgent.stream(...).toUIMessageStream(...)`
// emits AI SDK v6 UI parts: text deltas, tool-input/output events, etc.
// The wire format for the agent protocol is `{type:"response", text}` /
// `{type:"status"}` / `{type:"query"}` chunks per spec §6. This module is
// the seam — pure functions, no I/O.
//
// Tool calls are emitted as `status` chunks with a `<prefix>:<json>`
// payload, mirroring the convention `agents/claude-code` already uses
// and `examples/agent-web-ui/server/bridge.ts` already parses
// generically:
//
//   status: "tool_use:{\"id\":\"…\",\"name\":\"bash\",\"input\":{…}}"
//   status: "tool_result:{\"tool_use_id\":\"…\",\"output\":\"…\",\"is_error\":false}"
//
// Spec §6.4 requires callers to silently ignore unrecognised status
// values — that's the documented forward-compat hook. Dumb clients
// (e.g. `nats req`) get the model's `response` text without seeing any
// tool I/O; rich clients that opt into the convention get structured
// tool-call cards.

import type { Chunk } from "@synadia-ai/agent-service";

/** Loose UI-part shape — accepts every variant `toUIMessageStream` produces. */
export interface UIPart {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Translate one UI part into zero or more wire chunks.
 *
 * Returns `[]` for parts that are bookkeeping-only (start/finish, text
 * boundaries, error parts that the bridge re-raises as a 500). The
 * bridge concatenates the result and forwards each chunk to
 * `PromptResponse.send`. Long `response` text is the bridge's
 * responsibility to split via `splitResponseText`; this module emits
 * one chunk per logical event.
 */
export function translatePart(part: UIPart): Chunk[] {
  switch (part.type) {
    case "text-delta": {
      const delta = readString(part, "delta");
      if (delta === "") return [];
      return [{ type: "response", text: delta }];
    }

    case "tool-input-start":
      // The tool announcement is now carried by the `tool_use` status
      // chunk emitted on `tool-input-available` once the input is
      // ready. No need to write a separate text marker.
      return [];

    case "tool-input-available": {
      const toolCallId = readString(part, "toolCallId");
      const toolName = readString(part, "toolName");
      if (toolCallId === "" || toolName === "") return [];
      const input = isObject(part["input"]) ? part["input"] : {};
      const safeInput = summarizeToolInputForWire(toolName, input);
      const payload: ToolUsePayload = { id: toolCallId, name: toolName, input: safeInput };
      const encoded = safeStringify(payload);
      if (encoded === undefined) return [];
      return [{ type: "status", status: `tool_use:${encoded}` }];
    }

    case "tool-output-available": {
      const toolCallId = readString(part, "toolCallId");
      const toolName = readString(part, "toolName");
      if (toolCallId === "") return [];
      const output = summarizeToolOutput(toolName, part["output"]);
      const payload: ToolResultPayload = {
        tool_use_id: toolCallId,
        output,
        is_error: false,
      };
      const encoded = safeStringify(payload);
      if (encoded === undefined) return [];
      return [{ type: "status", status: `tool_result:${encoded}` }];
    }

    case "tool-output-error": {
      const toolCallId = readString(part, "toolCallId");
      if (toolCallId === "") return [];
      const errorText =
        readString(part, "errorText") || readString(part, "error") || "(no message)";
      const payload: ToolResultPayload = {
        tool_use_id: toolCallId,
        output: errorText,
        is_error: true,
      };
      const encoded = safeStringify(payload);
      if (encoded === undefined) return [];
      return [{ type: "status", status: `tool_result:${encoded}` }];
    }

    // Bookkeeping events — silent on the wire.
    case "start":
    case "start-step":
    case "finish-step":
    case "finish":
    case "text-start":
    case "text-end":
    case "tool-input-delta":
      return [];

    case "error":
      // Surface error parts via the bridge throwing — `AgentService` then
      // emits §9.1 + the §6.5 terminator. Don't write a partial chunk.
      return [];

    default:
      // Forward-compat: silently ignore unrecognised parts so a new AI
      // SDK release doesn't break the wire.
      return [];
  }
}

interface ToolUsePayload {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface ToolResultPayload {
  readonly tool_use_id: string;
  readonly output: string;
  readonly is_error: boolean;
}

function readString(part: UIPart, key: string): string {
  const value = part[key];
  return typeof value === "string" ? value : "";
}

/**
 * Cap on inline string fields in a `tool_use` payload before it ships
 * over the wire. The status chunk is **not** chunkable — it goes through
 * `response.send` directly, so a verbatim file body in `write.content`
 * or a large `edit.oldString` would blow `max_payload` and cascade into
 * a §9.1 500 before the tool ever ran. 1 KB per string is generous for
 * preview purposes; clients that need the full input can reconstruct
 * from `tool_result` (which is similarly summarised).
 */
const MAX_INLINE_INPUT_STRING_BYTES = 1024;

/**
 * Per-tool elision rules for `tool_use.input`. Keeps the wire under
 * `max_payload` for tools that take large string fields, while still
 * conveying intent (filePath, command, pattern).
 *
 * `write` and `edit` carry full file contents, so their fat fields are
 * always elided regardless of size. Other tools fall through to a
 * generic per-field cap so an unknown future tool with a giant input
 * doesn't surprise us with a 500.
 */
function summarizeToolInputForWire(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (toolName) {
    case "write":
      return elideStringFields(input, ["content"]);
    case "edit":
      return elideStringFields(input, ["oldString", "newString"]);
    default:
      return capStringValues(input, MAX_INLINE_INPUT_STRING_BYTES);
  }
}

function elideStringFields(
  input: Record<string, unknown>,
  fields: ReadonlyArray<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (fields.includes(key) && typeof value === "string") {
      out[key] = `<${value.length} chars elided>`;
    } else if (typeof value === "string" && value.length > MAX_INLINE_INPUT_STRING_BYTES) {
      out[key] = truncate(value, MAX_INLINE_INPUT_STRING_BYTES);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function capStringValues(
  input: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > maxBytes) {
      out[key] = truncate(value, maxBytes);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function summarizeToolOutput(toolName: string, output: unknown): string {
  if (output === undefined || output === null) return "";
  const obj = isObject(output) ? output : {};
  switch (toolName) {
    case "bash": {
      const exitCode = obj["exitCode"];
      const stdout = readObjectString(obj, "stdout");
      const stderr = readObjectString(obj, "stderr");
      const head = (stdout || stderr).split("\n").slice(0, 8).join("\n");
      return head ? `exit ${exitCode ?? "?"}\n${head}` : `exit ${exitCode ?? "?"}`;
    }
    case "read": {
      const totalLines = obj["totalLines"];
      return typeof totalLines === "number" ? `${totalLines} lines` : "";
    }
    case "write":
    case "edit": {
      const added = obj["added"];
      const removed = obj["removed"];
      if (typeof added === "number" || typeof removed === "number") {
        return `+${added ?? 0} -${removed ?? 0}`;
      }
      const success = obj["success"];
      return success === true ? "ok" : "";
    }
    case "grep":
    case "glob": {
      const matches = obj["matches"];
      if (Array.isArray(matches)) return `${matches.length} matches`;
      const count = obj["count"];
      if (typeof count === "number") return `${count} matches`;
      return "";
    }
    default: {
      const j = safeStringify(output);
      return j === undefined ? "" : truncate(j, 120);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObjectString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

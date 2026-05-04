// AI SDK UI-message-part → NATS Agent Protocol chunk translation.
//
// The vendored open-agents `ToolLoopAgent.stream(...).toUIMessageStream(...)`
// emits AI SDK v6 UI parts: text deltas, tool-input/output events, etc.
// The wire format for the agent protocol is `{type:"response", text}` /
// `{type:"status"}` / `{type:"query"}` chunks per spec §6. This module is
// the seam — pure functions, no I/O.

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
 * boundaries, error parts that the caller should reraise as a 500). The
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

    case "tool-input-start": {
      const toolName = readString(part, "toolName");
      return [{ type: "response", text: `\n[${toolName}] ` }];
    }

    case "tool-input-available": {
      const toolName = readString(part, "toolName");
      const input = part["input"];
      const summary = summarizeToolInput(toolName, input);
      if (summary === "") return [];
      return [{ type: "response", text: summary }];
    }

    case "tool-output-available": {
      const toolName = readString(part, "toolName");
      const output = part["output"];
      const summary = summarizeToolOutput(toolName, output);
      if (summary === "") return [];
      return [{ type: "response", text: `\n${summary}` }];
    }

    case "tool-output-error": {
      const toolName = readString(part, "toolName");
      const errorText = readString(part, "errorText") || readString(part, "error");
      return [
        {
          type: "response",
          text: `\n[${toolName} error] ${errorText || "(no message)"}`,
        },
      ];
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

function readString(part: UIPart, key: string): string {
  const value = part[key];
  return typeof value === "string" ? value : "";
}

function summarizeToolInput(toolName: string, input: unknown): string {
  if (input === undefined || input === null) return "";
  const obj = isObject(input) ? input : {};
  switch (toolName) {
    case "bash": {
      const command = readObjectString(obj, "command");
      return command ? `$ ${command}` : "";
    }
    case "read": {
      const filePath = readObjectString(obj, "filePath");
      return filePath ? `read ${filePath}` : "";
    }
    case "write": {
      const filePath = readObjectString(obj, "filePath");
      return filePath ? `write ${filePath}` : "";
    }
    case "edit": {
      const filePath = readObjectString(obj, "filePath");
      return filePath ? `edit ${filePath}` : "";
    }
    case "grep": {
      const pattern = readObjectString(obj, "pattern");
      return pattern ? `grep ${pattern}` : "";
    }
    case "glob": {
      const pattern = readObjectString(obj, "pattern") || readObjectString(obj, "filePattern");
      return pattern ? `glob ${pattern}` : "";
    }
    default: {
      const j = safeStringify(input);
      return j === undefined ? "" : truncate(j, 80);
    }
  }
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

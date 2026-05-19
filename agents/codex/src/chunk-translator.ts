// ACP `session/update` notification → Synadia Agent Protocol chunk(s).
//
// ACP defines a discriminated union of `SessionUpdate` shapes keyed by
// `sessionUpdate`. We translate the ones with a wire counterpart on the
// Synadia side; everything else is forward-compatibly ignored (spec §6.4
// requires callers to silently ignore unrecognised `status` values).
//
// Mapping:
//   agent_message_chunk  → {type:"response", text: <textContent>}
//   agent_thought_chunk  → {type:"status",   status: "thought:<text>"} (preview)
//   tool_call            → {type:"status",   status: "tool_use:<json>"}
//   tool_call_update     → {type:"status",   status: "tool_result:<json>"}
//   plan                 → {type:"status",   status: "plan:<json>"}
//   current_mode_update  → {type:"status",   status: "mode:<json>"}
//   user_message_chunk   → []  (echoes of our own prompt — no wire emit)
//   available_commands_update / session_info_update / config_option_update
//                        → [] (bookkeeping; rich clients can opt in later)
//
// Tool-call payloads mirror the `agents/claude-code` + `agents/open-agent`
// `<prefix>:<json>` convention so the existing `agent-web-ui` parser picks
// them up without changes.

import type { Chunk } from "@synadia-ai/agent-service";
import type {
  ContentBlock,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

/** Cap on inline string fields in a `tool_use` / `tool_result` payload. */
const MAX_INLINE_STRING_BYTES = 1024;

export function translateSessionUpdate(update: SessionUpdate): Chunk[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = readContentText(update.content);
      if (text.length === 0) return [];
      return [{ type: "response", text }];
    }

    case "agent_thought_chunk": {
      const text = readContentText(update.content);
      if (text.length === 0) return [];
      const preview = truncate(text, MAX_INLINE_STRING_BYTES);
      return [{ type: "status", status: `thought:${preview}` }];
    }

    case "tool_call": {
      const encoded = encodeToolCallStatus(update);
      return encoded === undefined ? [] : [{ type: "status", status: encoded }];
    }

    case "tool_call_update": {
      const encoded = encodeToolCallUpdateStatus(update);
      return encoded === undefined ? [] : [{ type: "status", status: encoded }];
    }

    case "plan": {
      const safe = safeStringify({ entries: update.entries });
      if (safe === undefined) return [];
      return [{ type: "status", status: `plan:${safe}` }];
    }

    case "current_mode_update": {
      const safe = safeStringify({ currentModeId: update.currentModeId });
      if (safe === undefined) return [];
      return [{ type: "status", status: `mode:${safe}` }];
    }

    // Bookkeeping / echoes — silent on the wire.
    case "user_message_chunk":
    case "available_commands_update":
    case "session_info_update":
    case "config_option_update":
    case "usage_update":
      return [];

    default:
      // Forward-compat: silently ignore unknown update kinds so a future
      // ACP SDK release with new variants doesn't break the wire.
      return [];
  }
}

function encodeToolCallStatus(tc: ToolCall & { sessionUpdate: "tool_call" }): string | undefined {
  const safe = safeStringify({
    id: tc.toolCallId,
    name: tc.title ?? tc.kind ?? "tool",
    kind: tc.kind,
    input: summarizeRecord(asRecord(tc.rawInput), MAX_INLINE_STRING_BYTES),
    status: tc.status,
  });
  return safe === undefined ? undefined : `tool_use:${safe}`;
}

function encodeToolCallUpdateStatus(
  tc: ToolCallUpdate & { sessionUpdate: "tool_call_update" },
): string | undefined {
  const isError = tc.status === "failed";
  const output = readToolCallOutput(tc);
  const safe = safeStringify({
    tool_use_id: tc.toolCallId,
    status: tc.status,
    output,
    is_error: isError,
  });
  return safe === undefined ? undefined : `tool_result:${safe}`;
}

function readContentText(block: ContentBlock | undefined): string {
  if (block === undefined) return "";
  if (block.type !== "text") return "";
  const text = block.text;
  return typeof text === "string" ? text : "";
}

function readToolCallOutput(
  tc: ToolCallUpdate & { sessionUpdate: "tool_call_update" },
): string {
  // `content` is a `ToolCallContent[]` — each entry is either a content
  // block (text / image / resource) or a diff / terminal handle. We only
  // surface text + a generic JSON dump for non-text variants so the wire
  // stays small. Rich clients can subscribe to `session/update` directly
  // for full fidelity once we land an ACP relay endpoint.
  const parts = tc.content;
  if (!Array.isArray(parts) || parts.length === 0) {
    const rawOutput = (tc as unknown as Record<string, unknown>)["rawOutput"];
    if (typeof rawOutput === "string") return truncate(rawOutput, MAX_INLINE_STRING_BYTES);
    if (rawOutput !== undefined) {
      const j = safeStringify(rawOutput);
      return j === undefined ? "" : truncate(j, MAX_INLINE_STRING_BYTES);
    }
    return "";
  }
  const chunks: string[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const obj = part as Record<string, unknown>;
    const inner = obj["content"];
    if (
      inner !== null &&
      typeof inner === "object" &&
      (inner as Record<string, unknown>)["type"] === "text"
    ) {
      const t = (inner as Record<string, unknown>)["text"];
      if (typeof t === "string") {
        chunks.push(t);
        continue;
      }
    }
    const j = safeStringify(part);
    if (j !== undefined) chunks.push(j);
  }
  return truncate(chunks.join("\n"), MAX_INLINE_STRING_BYTES);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function summarizeRecord(
  obj: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > maxBytes) {
      out[k] = truncate(v, maxBytes);
    } else {
      out[k] = v;
    }
  }
  return out;
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

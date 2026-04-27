import { reactive } from "vue";
import type { WireAttachment } from "../wire.ts";

export type MessageRole = "user" | "agent" | "query" | "tool";

export type ToolCallInfo = {
  /** Stable id assigned by the agent's SDK; same id will appear on the result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Result text, populated when the matching tool_result chunk arrives. */
  result?: string;
  isError?: boolean;
};

export type Message = {
  id: string;
  role: MessageRole;
  content: string;
  streaming: boolean;
  error?: string;
  statusNote?: string;
  timestamp: number;
  attachments?: WireAttachment[];
  // Populated on role === "query" only.
  queryId?: string;
  promptId?: string;
  replied?: boolean;
  replyValue?: string;
  // Populated on role === "tool" only.
  tool?: ToolCallInfo;
  // Optional per-turn cost annotation, set on the agent bubble that closed the turn.
  costUsd?: number;
};

export type Session = {
  instanceId: string;
  messages: Message[];
  activePromptId: string | null;
};

const sessions = reactive(new Map<string, Session>());

export function getSession(instanceId: string): Session {
  let s = sessions.get(instanceId);
  if (!s) {
    s = reactive<Session>({ instanceId, messages: [], activePromptId: null });
    sessions.set(instanceId, s);
  }
  return s;
}

export function messagesFor(instanceId: string): Message[] {
  return getSession(instanceId).messages;
}

export function appendMessage(instanceId: string, msg: Message): Message {
  const session = getSession(instanceId);
  session.messages.push(msg);
  return session.messages[session.messages.length - 1]!;
}

export function findMessage(instanceId: string, id: string): Message | undefined {
  return getSession(instanceId).messages.find((m) => m.id === id);
}

/** Locate a tool message by its agent-assigned tool_use id (used to pair results). */
export function findMessageByToolId(instanceId: string, toolUseId: string): Message | undefined {
  return getSession(instanceId).messages.find((m) => m.role === "tool" && m.tool?.id === toolUseId);
}

export function clearSession(instanceId: string): void {
  const s = sessions.get(instanceId);
  if (s) {
    s.messages = [];
    s.activePromptId = null;
  }
}

import { reactive } from "vue";
import type { WireAttachment } from "../wire.ts";

export type MessageRole = "user" | "agent" | "query";

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

export function clearSession(instanceId: string): void {
  const s = sessions.get(instanceId);
  if (s) {
    s.messages = [];
    s.activePromptId = null;
  }
}

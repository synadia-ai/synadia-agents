export interface OpenCodeEventMapResult {
  readonly type: "response" | "status" | "done" | "error" | "ignore";
  readonly text?: string;
}

export interface EventMapperState {
  readonly emittedTextByPart: Map<string, number>;
}

export function createEventMapperState(): EventMapperState {
  return { emittedTextByPart: new Map() };
}

export function mapOpenCodeEvent(event: unknown, state: EventMapperState = createEventMapperState()): OpenCodeEventMapResult {
  if (!isRecord(event)) return { type: "ignore" };
  const eventType = readString(event, "type") ?? readString(event, "event") ?? readString(event, "name");
  if (!eventType) return { type: "ignore" };

  if (eventType === "server.connected") return { type: "status", text: "connected to OpenCode server" };
  if (eventType === "server.heartbeat") return { type: "ignore" };
  if (eventType === "session.idle" || eventType === "session.done") return { type: "done" };
  if (eventType === "session.error") return { type: "error", text: extractText(event) ?? "OpenCode session error" };
  if (eventType === "permission.asked") return { type: "status", text: "OpenCode permission requested" };
  if (eventType === "permission.replied") return { type: "status", text: "OpenCode permission resolved" };

  if (eventType === "message.part.delta") {
    const text = extractText(event);
    return text ? { type: "response", text } : { type: "ignore" };
  }

  if (eventType === "message.part.updated") {
    const text = extractText(event);
    if (!text) return { type: "ignore" };
    const partKey = extractPartKey(event);
    if (!partKey) return { type: "ignore" };
    const emitted = state.emittedTextByPart.get(partKey) ?? 0;
    const delta = text.slice(emitted);
    state.emittedTextByPart.set(partKey, Math.max(emitted, text.length));
    return delta ? { type: "response", text: delta } : { type: "ignore" };
  }

  return { type: "ignore" };
}

function extractPartKey(event: Record<string, unknown>): string | undefined {
  const data = isRecord(event.data) ? event.data : event;
  const messageId = readString(data, "messageID") ?? readString(data, "messageId") ?? readString(data, "message_id");
  const partId = readString(data, "partID") ?? readString(data, "partId") ?? readString(data, "part_id");
  if (!messageId || !partId) return undefined;
  return `${messageId}:${partId}`;
}

function extractText(event: Record<string, unknown>): string | undefined {
  const data = isRecord(event.data) ? event.data : event;
  for (const key of ["text", "delta", "content", "message"] as const) {
    const value = readString(data, key);
    if (value) return value;
  }
  const part = isRecord(data.part) ? data.part : undefined;
  if (part) {
    for (const key of ["text", "delta", "content"] as const) {
      const value = readString(part, key);
      if (value) return value;
    }
  }
  return undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

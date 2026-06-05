export interface OpenCodeEventMapResult {
  readonly type: "response" | "status" | "done" | "error" | "ignore";
  readonly text?: string;
}

export interface EventMapperState {
  readonly emittedTextByPart: Map<string, number>;
  readonly messageRoles: Map<string, string>;
}

export function createEventMapperState(): EventMapperState {
  return { emittedTextByPart: new Map(), messageRoles: new Map() };
}

export function mapOpenCodeEvent(event: unknown, state: EventMapperState = createEventMapperState()): OpenCodeEventMapResult {
  if (!isRecord(event)) return { type: "ignore" };
  const eventType = readString(event, "type") ?? readString(event, "event") ?? readString(event, "name");
  if (!eventType) return { type: "ignore" };

  rememberMessageRole(event, state);

  if (eventType === "server.connected") return { type: "status", text: "connected to OpenCode server" };
  if (eventType === "server.heartbeat") return { type: "ignore" };
  if (eventType === "session.idle" || eventType === "session.done") return { type: "done" };
  if (eventType === "session.status") {
    const properties = readPayload(event);
    const status = isRecord(properties.status) ? readString(properties.status, "type") : undefined;
    if (status === "idle") return { type: "done" };
    if (status === "busy") return { type: "status", text: "OpenCode session busy" };
    if (status === "retry") return { type: "status", text: "OpenCode session retrying" };
    return { type: "ignore" };
  }
  if (eventType === "session.error") return { type: "error", text: extractText(event) ?? "OpenCode session error" };
  // Permission events are handled by the bridge client before generic event
  // mapping so it can reply with OpenCode's permission endpoint; this fallback
  // remains useful for raw mapper tests and unexpected policy paths.
  if (eventType === "permission.updated" || eventType === "permission.asked") return { type: "status", text: "OpenCode permission requested" };
  if (eventType === "permission.replied") return { type: "status", text: "OpenCode permission resolved" };

  if (eventType === "message.part.delta") {
    if (!isAssistantTextPart(event, state)) return { type: "ignore" };
    const text = extractText(event);
    return text ? { type: "response", text } : { type: "ignore" };
  }

  if (eventType === "message.part.updated") {
    if (!isAssistantTextPart(event, state)) return { type: "ignore" };
    const payload = readPayload(event);
    const explicitDelta = readString(payload, "delta");
    if (explicitDelta) {
      rememberPartLength(event, explicitDelta.length, state);
      return { type: "response", text: explicitDelta };
    }
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

export function eventSessionId(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const payload = readPayload(event);
  return readString(payload, "sessionID") ?? readString(payload, "sessionId") ?? readString(payload, "session_id")
    ?? (isRecord(payload.part) ? readString(payload.part, "sessionID") ?? readString(payload.part, "sessionId") : undefined)
    ?? (isRecord(payload.info) ? readString(payload.info, "sessionID") ?? readString(payload.info, "sessionId") : undefined);
}

function rememberMessageRole(event: Record<string, unknown>, state: EventMapperState): void {
  const eventType = readString(event, "type") ?? readString(event, "event") ?? readString(event, "name");
  if (eventType !== "message.updated") return;
  const payload = readPayload(event);
  const info = isRecord(payload.info) ? payload.info : payload;
  const id = readString(info, "id") ?? readString(info, "messageID") ?? readString(info, "messageId");
  const role = readString(info, "role");
  if (id && role) state.messageRoles.set(id, role);
}

function isAssistantTextPart(event: Record<string, unknown>, state: EventMapperState): boolean {
  const payload = readPayload(event);
  const part = isRecord(payload.part) ? payload.part : payload;
  const partType = readString(part, "type");
  if (partType && partType !== "text") return false;
  const messageId = readString(part, "messageID") ?? readString(part, "messageId") ?? readString(part, "message_id")
    ?? readString(payload, "messageID") ?? readString(payload, "messageId") ?? readString(payload, "message_id");
  if (!messageId) return true;
  const role = state.messageRoles.get(messageId);
  return role === undefined || role === "assistant";
}

function rememberPartLength(event: Record<string, unknown>, deltaLength: number, state: EventMapperState): void {
  const partKey = extractPartKey(event);
  if (!partKey) return;
  const previous = state.emittedTextByPart.get(partKey) ?? 0;
  state.emittedTextByPart.set(partKey, previous + deltaLength);
}

function extractPartKey(event: Record<string, unknown>): string | undefined {
  const payload = readPayload(event);
  const part = isRecord(payload.part) ? payload.part : payload;
  const messageId = readString(part, "messageID") ?? readString(part, "messageId") ?? readString(part, "message_id");
  const partId = readString(part, "id") ?? readString(part, "partID") ?? readString(part, "partId") ?? readString(part, "part_id");
  if (!messageId || !partId) return undefined;
  return `${messageId}:${partId}`;
}

function extractText(event: Record<string, unknown>): string | undefined {
  const payload = readPayload(event);
  for (const key of ["text", "delta", "content", "message"] as const) {
    const value = readString(payload, key);
    if (value) return value;
  }
  const part = isRecord(payload.part) ? payload.part : undefined;
  if (part) {
    for (const key of ["text", "delta", "content"] as const) {
      const value = readString(part, key);
      if (value) return value;
    }
  }
  const error = isRecord(payload.error) ? payload.error : undefined;
  if (error) {
    const data = isRecord(error.data) ? error.data : undefined;
    return readString(error, "message") ?? (data ? readString(data, "message") : undefined) ?? readString(error, "name");
  }
  return undefined;
}

function readPayload(event: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(event.properties)) return event.properties;
  if (isRecord(event.data)) return event.data;
  return event;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

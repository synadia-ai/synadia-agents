import type { OpenCodeBridgeClient, OpenCodeBridgeEvent, OpenCodePromptRequest } from "../bridge.js";
import { createEventMapperState, eventSessionId, mapOpenCodeEvent } from "../event-mapper.js";
import { policyDecision } from "../permissions.js";
import type { OpenCodePluginContext, PluginChannelState, PluginEventQueue, PluginPromptEventQueueItem } from "./types.js";
import { isPluginPermissionEvent, pluginPermissionQuestion, replyToPluginPermission } from "./permissions.js";
import { AsyncPluginEventQueue } from "./queue.js";

export class PluginOpenCodeBridgeClient implements OpenCodeBridgeClient {
  readonly mode = "plugin" as const;
  readonly #mapperState = createEventMapperState();
  #activeSessionId: string | undefined;
  #creatingSession: Promise<string> | undefined;

  constructor(
    private readonly ctx: OpenCodePluginContext,
    private readonly state: PluginChannelState,
  ) {
    this.#activeSessionId = state.config.opencode.sessionId;
  }

  async *prompt(request: OpenCodePromptRequest): AsyncIterable<OpenCodeBridgeEvent> {
    const directory = request.directory ?? this.state.config.opencode.directory;
    const sessionId = await this.ensureSession(request.sessionId, directory);
    const queue = new AsyncPluginEventQueue();
    this.state.promptCount += 1;
    this.state.activePrompts.set(sessionId, { sessionId, queue, createdAt: Date.now() });
    try {
      queue.push({ type: "status", text: `OpenCode plugin bridge selected; session=${sessionId}` });
      void this.invokeOpenCodePrompt(request, sessionId, directory, queue);
      for await (const item of queue) {
        if (item.type === "status" && item.text) yield { type: "status", text: item.text };
        if (item.type === "response" && item.text) yield { type: "response", text: item.text };
        if (item.type === "permission" && item.question && item.timeoutMs && item.decide) {
          yield { type: "permission", question: item.question, timeoutMs: item.timeoutMs, decide: item.decide };
        }
        if (item.type === "done") break;
      }
    } finally {
      this.state.activePrompts.delete(sessionId);
      queue.close();
    }
  }

  async handleEvent(event: unknown): Promise<void> {
    const summary = summarizePluginEvent(event);
    this.state.eventTypes.set(summary.type, (this.state.eventTypes.get(summary.type) ?? 0) + 1);
    const active = this.activePromptForEvent(event);
    if (!active) return;
    if (isPluginPermissionEvent(event)) {
      await this.handlePermissionEvent(event, active.queue);
      return;
    }
    const mapped = mapOpenCodeEvent(event, this.#mapperState);
    if (mapped.type === "response" && mapped.text) active.queue.push({ type: "response", text: mapped.text });
    if (mapped.type === "status" && mapped.text) active.queue.push({ type: "status", text: mapped.text });
    if (mapped.type === "done") active.queue.push({ type: "done" });
    if (mapped.type === "error") active.queue.fail(new Error(mapped.text ?? "OpenCode session error"));
  }

  private async invokeOpenCodePrompt(request: OpenCodePromptRequest, sessionId: string, directory: string | undefined, queue: PluginEventQueue): Promise<void> {
    try {
      const session = this.ctx.client?.session;
      if (!session?.prompt) {
        queue.push({ type: "status", text: "OpenCode plugin prompt API unavailable; waiting for plugin events" });
        return;
      }
      const result = await session.prompt({
        path: { id: sessionId },
        ...(directory ? { query: { directory } } : {}),
        body: {
          ...(request.model ? { model: parseModel(request.model) } : {}),
          ...(request.agent ? { agent: request.agent } : {}),
          parts: [{ type: "text", text: request.prompt }],
        },
      });
      if (result.error) throw new Error(`OpenCode plugin prompt failed: ${formatError(result.error)}`);
      const text = textFromPromptResult(result.data);
      if (text) queue.push({ type: "response", text });
      queue.push({ type: "done" });
    } catch (err) {
      queue.fail(err);
    }
  }

  private activePromptForEvent(event: unknown): { sessionId: string; queue: PluginEventQueue } | undefined {
    const sessionId = eventSessionId(event);
    if (sessionId && this.state.activePrompts.has(sessionId)) return this.state.activePrompts.get(sessionId);
    if (this.state.activePrompts.size === 1) return [...this.state.activePrompts.values()][0];
    return undefined;
  }

  private async ensureSession(requestedSessionId: string | undefined, directory: string | undefined): Promise<string> {
    const existing = requestedSessionId ?? this.#activeSessionId;
    if (existing) return validateOpenCodeSessionId(existing);
    this.#creatingSession ??= this.createSession(directory).finally(() => { this.#creatingSession = undefined; });
    return await this.#creatingSession;
  }

  private async createSession(directory: string | undefined): Promise<string> {
    const session = this.ctx.client?.session;
    if (!session?.create) {
      throw new Error("OpenCode plugin session.create API unavailable; set OPENCODE_SESSION_ID to an existing ses... session id");
    }
    const result = await session.create({
      body: { title: `NATS ${this.state.config.agent.owner}/${this.state.config.agent.name}` },
      ...(directory ? { query: { directory } } : {}),
    });
    if (result.error) throw new Error(`OpenCode plugin session create failed: ${formatError(result.error)}`);
    const sessionId = readSessionId(result.data);
    if (!sessionId) throw new Error("OpenCode plugin session create response did not include a ses... id");
    this.#activeSessionId = sessionId;
    return sessionId;
  }

  private async handlePermissionEvent(event: unknown, queue: PluginEventQueue): Promise<void> {
    const immediate = policyDecision(this.state.config.opencode.permissionPolicy);
    if (immediate) {
      await replyToPluginPermission({ ctx: this.ctx, event, reply: immediate.reply });
      queue.push({ type: "status", text: immediate.message ?? `OpenCode permission ${immediate.reply}` });
      return;
    }
    if (this.state.config.opencode.permissionPolicy === "local") {
      queue.push({ type: "status", text: "OpenCode permission delegated to local OpenCode UI/policy" });
      return;
    }
    queue.push({
      type: "permission",
      question: pluginPermissionQuestion(event),
      timeoutMs: this.state.config.opencode.permissionTimeoutMs,
      decide: async (reply) => {
        await replyToPluginPermission({ ctx: this.ctx, event, reply });
        this.state.permissionBridgeCount += 1;
      },
    });
  }
}

export function summarizePluginEvent(event: unknown): { type: string; keys: string[] } {
  if (!isRecord(event)) return { type: "unknown", keys: [] };
  const type = readString(event, "type") ?? readString(event, "event") ?? readString(event, "name") ?? "unknown";
  const payload = isRecord(event.properties) ? event.properties : isRecord(event.data) ? event.data : event;
  return { type, keys: Object.keys(payload).sort() };
}

function parseModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error("opencode.model must be provider/model");
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function textFromPromptResult(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.parts)) return "";
  return data.parts.map((part) => isRecord(part) && readString(part, "type") === "text" ? readString(part, "text") ?? "" : "").filter(Boolean).join("");
}

function readSessionId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const id = readString(data, "id");
  return id ? validateOpenCodeSessionId(id) : undefined;
}

function validateOpenCodeSessionId(sessionId: string): string {
  if (sessionId.startsWith("ses")) return sessionId;
  throw new Error(`OpenCode plugin session id must start with ses; got ${sessionId}`);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

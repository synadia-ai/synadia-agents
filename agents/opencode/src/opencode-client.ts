import { createOpencodeClient as createSdkOpenCodeClient, createOpencodeServer } from "@opencode-ai/sdk";
import type { Config as SdkOpenCodeConfig } from "@opencode-ai/sdk";
import type { OpenCodeChannelConfig, PermissionPolicy } from "./config.js";
import type { OpenCodeBridgeClient, OpenCodeBridgeEvent, OpenCodePromptRequest } from "./bridge.js";
import { createEventMapperState, eventSessionId, mapOpenCodeEvent } from "./event-mapper.js";
import { permissionIdsFromEvent, permissionQuestionFromEvent, policyDecision } from "./permissions.js";

interface SdkRequestResult<T = unknown> {
  readonly data?: T;
  readonly error?: unknown;
}

interface SdkEventStream {
  readonly stream: AsyncIterable<unknown>;
}

interface SdkOpenCodeClient {
  readonly event: {
    subscribe(options?: Record<string, unknown>): Promise<SdkEventStream>;
  };
  readonly session: {
    create(options?: Record<string, unknown>): Promise<SdkRequestResult>;
    prompt(options: Record<string, unknown>): Promise<SdkRequestResult>;
  };
  postSessionIdPermissionsPermissionId(options: Record<string, unknown>): Promise<SdkRequestResult<boolean>>;
}

interface ManagedOpenCodeServer {
  readonly url: string;
  close(): void;
}

export interface OpenCodeClientFactoryDeps {
  readonly createSdkClient?: (options: Record<string, unknown>) => SdkOpenCodeClient;
  readonly createManagedServer?: (config: OpenCodeChannelConfig) => Promise<ManagedOpenCodeServer>;
  readonly attachToServer?: (config: OpenCodeChannelConfig) => Promise<void>;
}

export async function createOpenCodeClient(config: OpenCodeChannelConfig, deps: OpenCodeClientFactoryDeps = {}): Promise<OpenCodeBridgeClient> {
  let baseUrl = config.opencode.baseUrl;
  let managedServer: ManagedOpenCodeServer | undefined;
  if (config.opencode.mode === "attached") {
    if (!baseUrl) throw new Error("attached OpenCode mode requires opencode.baseUrl");
    await deps.attachToServer?.(config);
  } else {
    managedServer = await (deps.createManagedServer ?? defaultCreateManagedServer)(config);
    baseUrl = managedServer.url;
  }
  const createSdkClient = deps.createSdkClient ?? ((options) => createSdkOpenCodeClient(options) as unknown as SdkOpenCodeClient);
  const client = createSdkClient({
    baseUrl,
    ...(config.opencode.directory ? { directory: config.opencode.directory } : {}),
    ...(config.opencode.serverPassword ? { headers: { Authorization: `Bearer ${config.opencode.serverPassword}` } } : {}),
  });
  return new SdkOpenCodeBridgeClient(config, client, managedServer);
}

async function defaultCreateManagedServer(config: OpenCodeChannelConfig): Promise<ManagedOpenCodeServer> {
  const permissionConfig = managedServerPermissionConfig(config.opencode.permissionPolicy);
  if (permissionConfig) {
    return await createOpencodeServer({
      hostname: config.opencode.hostname,
      port: config.opencode.port,
      config: permissionConfig,
    });
  }
  return await createOpencodeServer({
    hostname: config.opencode.hostname,
    port: config.opencode.port,
  });
}

export function managedServerPermissionConfig(policy: PermissionPolicy): SdkOpenCodeConfig | undefined {
  if (policy === "local") return undefined;
  return {
    permission: {
      bash: "ask",
      edit: "ask",
      external_directory: "ask",
      webfetch: "ask",
    },
  };
}

class SdkOpenCodeBridgeClient implements OpenCodeBridgeClient {
  readonly mode: "managed" | "attached";
  #activeSessionId: string | undefined;
  #creatingSession: Promise<string> | undefined;

  constructor(
    private readonly config: OpenCodeChannelConfig,
    private readonly client: SdkOpenCodeClient,
    private readonly managedServer: ManagedOpenCodeServer | undefined,
  ) {
    this.mode = config.opencode.mode;
    this.#activeSessionId = config.opencode.sessionId;
  }

  async *prompt(request: OpenCodePromptRequest): AsyncIterable<OpenCodeBridgeEvent> {
    const directory = request.directory ?? this.config.opencode.directory;
    const sessionId = await this.ensureSession(request.sessionId, directory);
    const streamAbort = new AbortController();
    const queue = new AsyncEventQueue();
    let responseChunks = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      streamAbort.abort();
      queue.push({ type: "done" });
      queue.close();
    };

    const sse = await this.client.event.subscribe({
      ...(directory ? { query: { directory } } : {}),
      signal: streamAbort.signal,
      sseMaxRetryAttempts: 0,
    });
    const mapperState = createEventMapperState();
    void (async () => {
      try {
        for await (const raw of sse.stream) {
          const rawSessionId = eventSessionId(raw);
          if (rawSessionId && rawSessionId !== sessionId) continue;
          if (isPermissionEvent(raw)) {
            await this.handlePermissionEvent(raw, directory, queue);
            continue;
          }
          const mapped = mapOpenCodeEvent(raw, mapperState);
          if (mapped.type === "response" && mapped.text) {
            responseChunks += 1;
            queue.push({ type: "response", text: mapped.text });
          } else if (mapped.type === "status" && mapped.text) {
            queue.push({ type: "status", text: mapped.text });
          } else if (mapped.type === "error") {
            queue.fail(new Error(mapped.text ?? "OpenCode session error"));
            finish();
            return;
          } else if (mapped.type === "done") {
            finish();
            return;
          }
        }
      } catch (err) {
        if (!streamAbort.signal.aborted) queue.fail(err);
      }
    })();

    queue.push({ type: "status", text: `connected to OpenCode ${this.mode} server; session=${sessionId}` });
    void (async () => {
      try {
        const model = request.model ?? this.config.opencode.model;
        const agent = request.agent ?? this.config.opencode.agent;
        const result = await this.client.session.prompt({
          path: { id: sessionId },
          ...(directory ? { query: { directory } } : {}),
          body: {
            ...(model ? { model: parseModel(model) } : {}),
            ...(agent ? { agent } : {}),
            parts: [{ type: "text", text: request.prompt }],
          },
        });
        if (result.error) throw new Error(`OpenCode prompt failed: ${formatError(result.error)}`);
        const fallbackText = responseChunks === 0 ? textFromPromptResult(result.data) : "";
        if (fallbackText) queue.push({ type: "response", text: fallbackText });
        finish();
      } catch (err) {
        queue.fail(err);
        finish();
      }
    })();

    for await (const event of queue) {
      if (event.type !== "done") yield event;
    }
  }

  async close(): Promise<void> {
    this.managedServer?.close();
  }

  private async ensureSession(requestedSessionId: string | undefined, directory: string | undefined): Promise<string> {
    const existing = requestedSessionId ?? this.#activeSessionId;
    if (existing) return existing;
    this.#creatingSession ??= this.createSession(directory).finally(() => { this.#creatingSession = undefined; });
    return await this.#creatingSession;
  }

  private async createSession(directory: string | undefined): Promise<string> {
    const result = await this.client.session.create({
      body: { title: `NATS ${this.config.agent.owner}/${this.config.agent.name}` },
      ...(directory ? { query: { directory } } : {}),
    });
    if (result.error) throw new Error(`OpenCode session create failed: ${formatError(result.error)}`);
    const id = readString(result.data, "id");
    if (!id) throw new Error("OpenCode session create response did not include an id");
    this.#activeSessionId = id;
    return id;
  }

  private async handlePermissionEvent(event: unknown, directory: string | undefined, queue: AsyncEventQueue): Promise<void> {
    const ids = permissionIdsFromEvent(event);
    if (!ids) {
      queue.push({ type: "status", text: "OpenCode permission requested without ids; ignoring" });
      return;
    }
    const immediate = policyDecision(this.config.opencode.permissionPolicy);
    if (immediate) {
      await this.replyPermission(ids.sessionId, ids.permissionId, immediate.reply, directory);
      queue.push({ type: "status", text: immediate.message ?? `OpenCode permission ${immediate.reply}` });
      return;
    }
    if (this.config.opencode.permissionPolicy === "local") {
      queue.push({ type: "status", text: "OpenCode permission delegated to local OpenCode UI/policy" });
      return;
    }
    queue.push({
      type: "permission",
      question: permissionQuestionFromEvent(event),
      timeoutMs: this.config.opencode.permissionTimeoutMs,
      decide: async (reply) => {
        await this.replyPermission(ids.sessionId, ids.permissionId, reply === "always" ? "always" : reply === "reject" ? "reject" : "once", directory);
      },
    });
  }

  private async replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject", directory: string | undefined): Promise<void> {
    const result = await this.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      ...(directory ? { query: { directory } } : {}),
      body: { response },
    });
    if (result.error) throw new Error(`OpenCode permission reply failed: ${formatError(result.error)}`);
  }
}

function isPermissionEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  const type = readString(event, "type") ?? readString(event, "event") ?? readString(event, "name");
  return type === "permission.updated" || type === "permission.asked";
}

function parseModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error("opencode.model must be provider/model");
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function textFromPromptResult(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.parts)) return "";
  return data.parts
    .map((part) => isRecord(part) && readString(part, "type") === "text" ? readString(part, "text") ?? "" : "")
    .filter(Boolean)
    .join("");
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class AsyncEventQueue implements AsyncIterable<OpenCodeBridgeEvent> {
  #events: OpenCodeBridgeEvent[] = [];
  #waiters: Array<{
    resolve(result: IteratorResult<OpenCodeBridgeEvent>): void;
    reject(error: unknown): void;
  }> = [];
  #closed = false;
  #error: unknown;

  push(event: OpenCodeBridgeEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.#events.push(event);
  }

  fail(error: unknown): void {
    this.#error = error;
    this.#closed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()?.reject(error);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()?.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<OpenCodeBridgeEvent> {
    return {
      next: async () => {
        if (this.#error) throw this.#error;
        const event = this.#events.shift();
        if (event) return { value: event, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<OpenCodeBridgeEvent>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

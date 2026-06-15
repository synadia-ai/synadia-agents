import { spawn } from "node:child_process";
import type { JsonObject, JsonValue, JsonRpcNotification, ServerRequestHandlerInput } from "./codex-jsonrpc.js";
import { asObject, asString, ChildProcessJsonRpcTransport, JsonLineRpcClient } from "./codex-jsonrpc.js";
import { createUnixSocketTransport, createWebSocketTransport, requireAttachedEndpointAuth } from "./endpoint.js";
import type { PermissionRequestSink } from "./permissions.js";
import { resolvePermissionRequest } from "./permissions.js";
import { isThreadStartedNotification } from "./session-watch.js";

export interface CodexAppServerProcessOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly permissionSink?: PermissionRequestSink;
  readonly permissionTimeoutMs?: number;
}

export interface CodexAttachedEndpointOptions {
  readonly endpoint: string;
  readonly authToken?: string;
  readonly permissionSink?: PermissionRequestSink;
  readonly permissionTimeoutMs?: number;
}

export interface CodexInitializeResult {
  readonly userAgent: string;
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
}

export interface CodexTurnStreamEvent {
  readonly type: "status" | "response";
  readonly text: string;
}

export class CodexAppServerClient {
  readonly #rpc: JsonLineRpcClient;
  #threadId: string | undefined;
  #initializeResult: CodexInitializeResult | undefined;
  #stderr = "";
  #permissionSink: PermissionRequestSink | undefined;
  #permissionTimeoutMs: number | undefined;

  private constructor(rpc: JsonLineRpcClient, opts: { readonly permissionSink?: PermissionRequestSink; readonly permissionTimeoutMs?: number }) {
    this.#permissionSink = opts.permissionSink;
    this.#permissionTimeoutMs = opts.permissionTimeoutMs;
    this.#rpc = rpc;
    this.#rpc.onStderr((chunk) => { this.#stderr = (this.#stderr + chunk).slice(-12_000); });
  }

  static spawn(opts: CodexAppServerProcessOptions): CodexAppServerClient {
    const args = opts.args ?? ["app-server", "--listen", "stdio://"];
    const child = spawn(opts.command, [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const clientRef: { current?: CodexAppServerClient } = {};
    const rpc = new JsonLineRpcClient(new ChildProcessJsonRpcTransport(child), {
      serverRequestHandler: (input: ServerRequestHandlerInput) => {
        return clientRef.current
          ? resolvePermissionRequest(input, clientRef.current.#permissionOptions())
          : resolvePermissionRequest(input);
      },
    });
    const clientOpts: { permissionSink?: PermissionRequestSink; permissionTimeoutMs?: number } = {};
    if (opts.permissionSink !== undefined) clientOpts.permissionSink = opts.permissionSink;
    if (opts.permissionTimeoutMs !== undefined) clientOpts.permissionTimeoutMs = opts.permissionTimeoutMs;
    const client = new CodexAppServerClient(rpc, clientOpts);
    clientRef.current = client;
    return client;
  }

  static async connectEndpoint(opts: CodexAttachedEndpointOptions): Promise<CodexAppServerClient> {
    const parsed = requireAttachedEndpointAuth(opts.endpoint, opts.authToken);
    const transport = parsed.kind === "unix"
      ? await createUnixSocketTransport(parsed.socketPath!)
      : await createWebSocketTransport(parsed.websocketUrl!, opts.authToken);
    const clientRef: { current?: CodexAppServerClient } = {};
    const rpc = new JsonLineRpcClient(transport, {
      serverRequestHandler: (input: ServerRequestHandlerInput) => {
        return clientRef.current
          ? resolvePermissionRequest(input, clientRef.current.#permissionOptions())
          : resolvePermissionRequest(input);
      },
    });
    const clientOpts: { permissionSink?: PermissionRequestSink; permissionTimeoutMs?: number } = {};
    if (opts.permissionSink !== undefined) clientOpts.permissionSink = opts.permissionSink;
    if (opts.permissionTimeoutMs !== undefined) clientOpts.permissionTimeoutMs = opts.permissionTimeoutMs;
    const client = new CodexAppServerClient(rpc, clientOpts);
    clientRef.current = client;
    return client;
  }

  get stderrTail(): string { return this.#stderr; }
  get threadId(): string | undefined { return this.#threadId; }
  get initialized(): CodexInitializeResult | undefined { return this.#initializeResult; }

  setPermissionSink(sink: PermissionRequestSink | undefined): void {
    this.#permissionSink = sink;
  }

  onThreadStarted(listener: () => void): () => void {
    return this.#rpc.onNotification((notification) => {
      if (isThreadStartedNotification(notification)) listener();
    });
  }

  async initialize(timeoutMs = 15_000): Promise<CodexInitializeResult> {
    const result = asObject(await this.#rpc.request("initialize", {
      clientInfo: { name: "synadia-codex-agent", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, { timeoutMs }), "initialize result");
    this.#rpc.notify("initialized");
    this.#initializeResult = {
      userAgent: asString(result.userAgent, "initialize.userAgent"),
      codexHome: asString(result.codexHome, "initialize.codexHome"),
      platformFamily: asString(result.platformFamily, "initialize.platformFamily"),
      platformOs: asString(result.platformOs, "initialize.platformOs"),
    };
    return this.#initializeResult;
  }

  async startThread(opts: { readonly cwd?: string; readonly approvalPolicy?: "never" | "on-request"; readonly timeoutMs?: number } = {}): Promise<string> {
    const params: JsonObject = {
      cwd: opts.cwd ?? process.cwd(),
      approvalPolicy: opts.approvalPolicy ?? "never",
      ephemeral: true,
      baseInstructions: "You are a headless Codex app-server session exposed through the Synadia Agent Protocol. Keep responses concise.",
    };
    const result = asObject(await this.#rpc.request("thread/start", params, { timeoutMs: opts.timeoutMs ?? 20_000 }), "thread/start result");
    const thread = asObject(result.thread, "thread/start.thread");
    this.#threadId = asString(thread.id, "thread.id");
    return this.#threadId;
  }

  async listLoadedThreads(timeoutMs = 15_000): Promise<JsonObject[]> {
    return asThreadList(await this.#rpc.request("thread/loaded/list", {}, { timeoutMs }), "thread/loaded/list result");
  }

  async listThreads(timeoutMs = 15_000): Promise<JsonObject[]> {
    return asThreadList(await this.#rpc.request("thread/list", {}, { timeoutMs }), "thread/list result");
  }

  async readThread(threadId: string, timeoutMs = 15_000): Promise<JsonObject> {
    return asObject(await this.#rpc.request("thread/read", { threadId }, { timeoutMs }), "thread/read result");
  }

  async resumeThread(threadId: string, timeoutMs = 15_000): Promise<JsonObject> {
    const result = asObject(await this.#rpc.request("thread/resume", { threadId }, { timeoutMs }), "thread/resume result");
    this.#threadId = threadId;
    return result;
  }

  async *turn(prompt: string, opts: { readonly timeoutMs?: number; readonly cwd?: string } = {}): AsyncIterable<CodexTurnStreamEvent> {
    const threadId = this.#threadId ?? await this.startThread(opts.cwd === undefined ? {} : { cwd: opts.cwd });
    const pending: JsonRpcNotification[] = [];
    let wake: (() => void) | undefined;
    const off = this.#rpc.onNotification((notification) => {
      pending.push(notification);
      if (wake) { const w = wake; wake = undefined; w(); }
    });
    let turnId = "";
    try {
      const result = asObject(await this.#rpc.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        approvalPolicy: "never",
      }, { timeoutMs: 20_000 }), "turn/start result");
      const turn = asObject(result.turn, "turn/start.turn");
      turnId = asString(turn.id, "turn.id");
      yield { type: "status", text: "Codex turn started" };
      const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
      for (;;) {
        while (pending.length > 0) {
          const notification = pending.shift()!;
          const event = mapNotification(notification, threadId, turnId);
          if (event?.type === "response" && event.text.length > 0) yield event;
          if (event?.type === "status") yield event;
          if (isTerminal(notification, threadId, turnId)) return;
          if (isFatal(notification, threadId, turnId)) throw new Error(notificationErrorText(notification));
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Codex turn timed out before completion");
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(() => {
            if (wake === resolve) wake = undefined;
            resolve();
          }, Math.min(remaining, 500));
        });
      }
    } finally {
      off();
    }
  }

  async close(): Promise<void> {
    this.#rpc.close();
  }

  #permissionOptions(): { sink?: PermissionRequestSink; timeoutMs?: number } {
    const permissionOpts: { sink?: PermissionRequestSink; timeoutMs?: number } = {};
    if (this.#permissionSink !== undefined) permissionOpts.sink = this.#permissionSink;
    if (this.#permissionTimeoutMs !== undefined) permissionOpts.timeoutMs = this.#permissionTimeoutMs;
    return permissionOpts;
  }
}

function asThreadList(value: JsonValue, field: string): JsonObject[] {
  const obj = asObject(value, field);
  const threads = obj.threads;
  if (!Array.isArray(threads)) throw new Error(`${field}.threads must be an array`);
  return threads.map((thread, index) => asObject(thread, `${field}.threads[${index}]`));
}

function mapNotification(notification: JsonRpcNotification, threadId: string, turnId: string): CodexTurnStreamEvent | null {
  const params = notification.params && typeof notification.params === "object" && !Array.isArray(notification.params) ? notification.params as JsonObject : {};
  if (params.threadId !== undefined && params.threadId !== threadId) return null;
  if (params.turnId !== undefined && params.turnId !== turnId) return null;
  if (notification.method === "agent/message/delta") return { type: "response", text: asString(params.delta, "agent/message/delta.delta") };
  if (notification.method === "thread/realtime/transcript/delta" && params.role === "assistant") return { type: "response", text: asString(params.delta, "thread/realtime/transcript/delta.delta") };
  if (notification.method === "item/completed") {
    const item = params.item && typeof params.item === "object" && !Array.isArray(params.item) ? params.item as JsonObject : undefined;
    if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.length > 0) return { type: "response", text: item.text };
  }
  if (notification.method === "warning") return { type: "status", text: `Codex warning: ${String(params.message ?? "warning")}` };
  return null;
}

function isTerminal(notification: JsonRpcNotification, threadId: string, turnId: string): boolean {
  const params = notification.params && typeof notification.params === "object" && !Array.isArray(notification.params) ? notification.params as JsonObject : {};
  if (params.threadId !== undefined && params.threadId !== threadId) return false;
  if (params.turnId !== undefined && params.turnId !== turnId) return false;
  return notification.method === "turn/completed" || notification.method === "turn/failed" || notification.method === "turn/cancelled";
}

function isFatal(notification: JsonRpcNotification, threadId: string, turnId: string): boolean {
  if (notification.method !== "error") return false;
  const params = notification.params && typeof notification.params === "object" && !Array.isArray(notification.params) ? notification.params as JsonObject : {};
  if (params.threadId !== undefined && params.threadId !== threadId) return false;
  if (params.turnId !== undefined && params.turnId !== turnId) return false;
  return params.willRetry !== true;
}

function notificationErrorText(notification: JsonRpcNotification): string {
  const params = notification.params && typeof notification.params === "object" && !Array.isArray(notification.params) ? notification.params as JsonObject : {};
  const error = params.error && typeof params.error === "object" && !Array.isArray(params.error) ? params.error as JsonObject : undefined;
  return String(error?.message ?? params.message ?? "Codex app-server error");
}

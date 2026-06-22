import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonRpcTransport } from "./endpoint.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };
export type JsonObject = { [key: string]: JsonValue | undefined };

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: JsonValue;
}

export interface JsonRpcNotification {
  readonly jsonrpc?: "2.0";
  readonly method: string;
  readonly params?: JsonValue;
}

export interface JsonRpcSuccess {
  readonly id: number | string;
  readonly result: JsonValue;
}

export interface JsonRpcFailure {
  readonly id: number | string;
  readonly error: { readonly code?: number; readonly message: string; readonly data?: JsonValue };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type ServerMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;

export interface ServerRequestHandlerInput {
  readonly method: string;
  readonly params?: JsonValue;
}

export type ServerRequestHandler = (input: ServerRequestHandlerInput) => Promise<JsonValue> | JsonValue;

export class JsonRpcError extends Error {
  readonly code: number | undefined;
  readonly data: JsonValue | undefined;

  constructor(message: string, opts: { readonly code?: number; readonly data?: JsonValue } = {}) {
    super(message);
    this.name = "JsonRpcError";
    this.code = opts.code;
    this.data = opts.data;
  }
}

export class JsonLineRpcClient {
  readonly #transport: JsonRpcTransport;
  readonly #pending = new Map<number | string, { resolve: (value: JsonValue) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly #events = new EventEmitter();
  #nextId = 1;
  #buffer = "";
  #closed = false;
  #serverRequestHandler: ServerRequestHandler | undefined;

  constructor(transport: JsonRpcTransport, opts: { readonly serverRequestHandler?: ServerRequestHandler } = {}) {
    this.#transport = transport;
    this.#serverRequestHandler = opts.serverRequestHandler;
    transport.onData((chunk: string) => this.#onData(chunk));
    transport.onStderr((chunk: string) => this.#events.emit("stderr", chunk));
    transport.onClose((err) => this.#close(err));
  }

  onNotification(listener: (message: JsonRpcNotification) => void): () => void {
    this.#events.on("notification", listener);
    return () => this.#events.off("notification", listener);
  }

  onStderr(listener: (chunk: string) => void): () => void {
    this.#events.on("stderr", listener);
    return () => this.#events.off("stderr", listener);
  }

  request(method: string, params?: JsonValue, opts: { readonly timeoutMs?: number } = {}): Promise<JsonValue> {
    if (this.#closed) return Promise.reject(new Error("JSON-RPC transport is closed"));
    const id = this.#nextId++;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const message: JsonRpcRequest = params === undefined
      ? { jsonrpc: "2.0", id, method }
      : { jsonrpc: "2.0", id, method, params };
    this.#write(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`JSON-RPC request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params?: JsonValue): void {
    const message = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.#write(message);
  }

  close(): void {
    this.#close(new Error("JSON-RPC transport closed"));
    this.#transport.close();
  }

  #write(message: unknown): void {
    this.#transport.write(`${JSON.stringify(message)}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(line) as ServerMessage;
      } catch (err) {
        this.#events.emit("stderr", `invalid JSON-RPC line from app-server: ${err instanceof Error ? err.message : String(err)}\n`);
        continue;
      }
      void this.#dispatch(parsed);
    }
  }

  async #dispatch(message: ServerMessage): Promise<void> {
    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("error" in message) {
        const opts: { code?: number; data?: JsonValue } = {};
        if (message.error.code !== undefined) opts.code = message.error.code;
        if (message.error.data !== undefined) opts.data = message.error.data;
        pending.reject(new JsonRpcError(message.error.message, opts));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ("id" in message && "method" in message) {
      await this.#handleServerRequest(message);
      return;
    }

    if ("method" in message) this.#events.emit("notification", message as JsonRpcNotification);
  }

  async #handleServerRequest(message: JsonRpcRequest): Promise<void> {
    try {
      const result = this.#serverRequestHandler
        ? await this.#serverRequestHandler(message.params === undefined ? { method: message.method } : { method: message.method, params: message.params })
        : defaultServerRequestResponse(message.method);
      this.#write({ jsonrpc: "2.0", id: message.id, result });
    } catch (err) {
      this.#write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#events.emit("close", error);
  }
}

export class ChildProcessJsonRpcTransport implements JsonRpcTransport {
  readonly #child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
  }

  write(line: string): void { this.#child.stdin.write(line); }
  close(): void { if (!this.#child.killed) this.#child.kill("SIGTERM"); }
  onData(listener: (chunk: string) => void): void { this.#child.stdout.on("data", listener); }
  onStderr(listener: (chunk: string) => void): void { this.#child.stderr.on("data", listener); }
  onClose(listener: (error: Error) => void): void {
    this.#child.once("exit", (code, signal) => listener(new Error(`codex app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`)));
    this.#child.once("error", listener);
  }
}

export function defaultServerRequestResponse(method: string): JsonValue {
  if (method === "item/commandExecution/requestApproval") return { decision: "cancel" };
  if (method === "item/fileChange/requestApproval") return { decision: "cancel" };
  if (method === "item/permissions/requestApproval") return null;
  if (method === "item/tool/requestUserInput") return { answer: { type: "cancel" } };
  if (method === "mcpServer/elicitation/request") return { action: "cancel" };
  return null;
}

export function asObject(value: JsonValue | undefined, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as JsonObject;
}

export function asString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

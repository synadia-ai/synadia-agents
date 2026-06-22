import { createConnection, type Socket } from "node:net";
import { basename } from "node:path";

export type CodexEndpointKind = "unix" | "websocket";

export interface ParsedCodexEndpoint {
  readonly kind: CodexEndpointKind;
  readonly endpoint: string;
  readonly redacted: string;
  readonly isLoopback: boolean;
  readonly socketPath?: string;
  readonly websocketUrl?: string;
}

export interface JsonRpcTransport {
  write(line: string): void;
  close(): void;
  onData(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onClose(listener: (error: Error) => void): void;
}

export function parseCodexEndpoint(endpoint: string): ParsedCodexEndpoint {
  if (endpoint.startsWith("unix://")) {
    const rawPath = endpoint.slice("unix://".length);
    if (!rawPath.startsWith("/")) throw new Error("attached endpoint unix:// form must contain an absolute socket path");
    return {
      kind: "unix",
      endpoint,
      socketPath: rawPath,
      redacted: `unix://[REDACTED]/${basename(rawPath)}`,
      isLoopback: true,
    };
  }
  if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();
    const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    return {
      kind: "websocket",
      endpoint,
      websocketUrl: endpoint,
      redacted: `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`,
      isLoopback,
    };
  }
  throw new Error("attached endpoint must be explicit: unix:///absolute/socket or ws(s)://host:port/path");
}

export function requireAttachedEndpointAuth(endpoint: string, authToken: string | undefined): ParsedCodexEndpoint {
  const parsed = parseCodexEndpoint(endpoint);
  if (parsed.kind === "websocket" && !parsed.isLoopback && !authToken) {
    throw new Error("non-loopback WebSocket attached endpoints require --endpoint-auth or SYNADIA_CODEX_ENDPOINT_AUTH");
  }
  return parsed;
}

export function createUnixSocketTransport(socketPath: string): Promise<JsonRpcTransport> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const cleanup = (): void => { socket.off("error", reject); };
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      cleanup();
      resolve(new SocketJsonRpcTransport(socket));
    });
    socket.once("error", reject);
  });
}

export function createWebSocketTransport(url: string, authToken?: string): Promise<JsonRpcTransport> {
  return new Promise((resolve, reject) => {
    const WebSocketCtor = WebSocket as unknown as new (url: string, opts?: { headers?: Record<string, string> }) => WebSocket;
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
    const ws = headers ? new WebSocketCtor(url, { headers }) : new WebSocketCtor(url);
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      resolve(new WebSocketJsonRpcTransport(ws));
    }, { once: true });
    ws.addEventListener("error", () => fail(`WebSocket endpoint ${new URL(url).origin} failed to open`), { once: true });
    ws.addEventListener("close", (event) => fail(`WebSocket endpoint closed before open code=${event.code}`), { once: true });
  });
}

export function normalizeWebSocketJsonRpcFrame(data: unknown): string | undefined {
  if (typeof data === "string") return ensureJsonLineFrame(data);
  if (data instanceof ArrayBuffer) return ensureJsonLineFrame(new TextDecoder().decode(data));
  return undefined;
}

export function ensureJsonLineFrame(value: string): string {
  return value.includes("\n") ? value : `${value}\n`;
}

class SocketJsonRpcTransport implements JsonRpcTransport {
  readonly #socket: Socket;

  constructor(socket: Socket) {
    this.#socket = socket;
  }

  write(line: string): void { this.#socket.write(line); }
  close(): void { this.#socket.destroy(); }
  onData(listener: (chunk: string) => void): void { this.#socket.on("data", listener); }
  onStderr(_listener: (chunk: string) => void): void {}
  onClose(listener: (error: Error) => void): void {
    this.#socket.once("close", () => listener(new Error("JSON-RPC socket transport closed")));
    this.#socket.once("error", listener);
  }
}

class WebSocketJsonRpcTransport implements JsonRpcTransport {
  readonly #ws: WebSocket;

  constructor(ws: WebSocket) { this.#ws = ws; }

  write(line: string): void { this.#ws.send(line); }
  close(): void { this.#ws.close(); }
  onData(listener: (chunk: string) => void): void {
    this.#ws.addEventListener("message", (event) => {
      const frame = normalizeWebSocketJsonRpcFrame(event.data);
      if (frame !== undefined) listener(frame);
    });
  }
  onStderr(_listener: (chunk: string) => void): void {}
  onClose(listener: (error: Error) => void): void {
    this.#ws.addEventListener("close", (event) => listener(new Error(`JSON-RPC WebSocket transport closed code=${event.code}`)), { once: true });
    this.#ws.addEventListener("error", () => listener(new Error("JSON-RPC WebSocket transport error")), { once: true });
  }
}

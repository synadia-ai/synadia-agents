import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { endpointFingerprint, privateSessionKey } from "./identity.js";
import type { CodexPluginConfig } from "./types.js";

export type CodexPluginRegistrationState = "metadata-only" | "promptable";

export interface CodexPluginNotification {
  readonly event: string;
  readonly endpoint?: string;
  readonly threadId?: string;
  readonly source?: string;
  readonly timestamp?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface CodexPluginEventRecord {
  readonly event: string;
  readonly source: string;
  readonly receivedAt: string;
  readonly endpoint?: string;
  readonly threadId?: string;
  readonly endpointFingerprint?: string;
  readonly privateKey?: string;
  readonly registrationState: CodexPluginRegistrationState;
}

export interface CodexPluginEventSnapshot {
  readonly event: string;
  readonly source: string;
  readonly receivedAt: string;
  readonly endpointFingerprint?: string;
  readonly endpointPresent: boolean;
  readonly threadIdPresent: boolean;
  readonly registrationState: CodexPluginRegistrationState;
}

export interface CodexPluginRegistrarOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly statePath?: string;
  readonly onEvent?: (event: CodexPluginEventRecord) => void | Promise<void>;
}

export interface EmitCodexPluginNotificationOptions {
  readonly registrarUrl: string;
  readonly token: string;
  readonly event: CodexPluginNotification;
}

export interface CodexPluginStatus {
  readonly installed: boolean;
  readonly hookTrusted: boolean;
  readonly registrarConfigured: boolean;
  readonly registrarUrl?: string;
  readonly lastEvent?: CodexPluginEventSnapshot;
}

export const DEFAULT_PLUGIN_REGISTRAR_HOST = "127.0.0.1";
export const DEFAULT_PLUGIN_REGISTRAR_PORT = 8717;

export function defaultPluginConfig(): CodexPluginConfig {
  return {
    enabled: false,
    registrarHost: DEFAULT_PLUGIN_REGISTRAR_HOST,
    registrarPort: DEFAULT_PLUGIN_REGISTRAR_PORT,
  };
}

export class CodexPluginRegistrar {
  readonly #opts: CodexPluginRegistrarOptions;
  #server: ReturnType<typeof Bun.serve> | undefined;
  #lastEvent: CodexPluginEventRecord | undefined;

  constructor(opts: CodexPluginRegistrarOptions) { this.#opts = opts; }

  get url(): string | undefined {
    return this.#server ? `http://${this.#opts.host}:${this.#server.port}` : undefined;
  }

  get lastEvent(): CodexPluginEventRecord | undefined { return this.#lastEvent; }

  start(): void {
    if (this.#server) return;
    this.#server = Bun.serve({
      hostname: this.#opts.host,
      port: this.#opts.port,
      fetch: async (request) => await this.#handleRequest(request),
    });
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    server?.stop(true);
  }

  async #handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, lastEvent: this.#lastEvent ? pluginEventSnapshot(this.#lastEvent) : undefined });
    }
    if (request.method !== "POST" || url.pathname !== "/codex/plugin/events") {
      return new Response("not found", { status: 404 });
    }
    const token = request.headers.get("x-synadia-codex-registrar-token") ?? "";
    if (token !== this.#opts.token) return new Response("unauthorized", { status: 401 });
    const payload = await request.json().catch(() => undefined);
    const event = normalizePluginNotification(payload);
    this.#lastEvent = event;
    writePluginState(this.#opts.statePath, pluginEventSnapshot(event));
    await this.#opts.onEvent?.(event);
    return Response.json({ ok: true, registrationState: event.registrationState }, { status: 202 });
  }
}

export function normalizePluginNotification(value: unknown): CodexPluginEventRecord {
  if (!isRecord(value)) throw new Error("plugin notification must be a JSON object");
  const event = typeof value.event === "string" && value.event.trim() ? value.event.trim() : "SessionEvent";
  const endpoint = typeof value.endpoint === "string" && value.endpoint.trim() ? value.endpoint.trim() : undefined;
  const threadId = typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : undefined;
  const source = typeof value.source === "string" && value.source.trim() ? value.source.trim() : "codex-plugin";
  const receivedAt = new Date(typeof value.timestamp === "number" && Number.isFinite(value.timestamp) ? value.timestamp : Date.now()).toISOString();
  const fingerprint = endpoint ? endpointFingerprint(endpoint) : undefined;
  const key = endpoint && threadId ? privateSessionKey(endpoint, threadId) : undefined;
  return {
    event,
    source,
    receivedAt,
    ...(endpoint ? { endpoint } : {}),
    ...(threadId ? { threadId } : {}),
    ...(fingerprint ? { endpointFingerprint: fingerprint } : {}),
    ...(key ? { privateKey: key } : {}),
    registrationState: "metadata-only",
  };
}

export function pluginEventSnapshot(event: CodexPluginEventRecord, promptable = false): CodexPluginEventSnapshot {
  return {
    event: event.event,
    source: event.source,
    receivedAt: event.receivedAt,
    ...(event.endpointFingerprint ? { endpointFingerprint: event.endpointFingerprint } : {}),
    endpointPresent: Boolean(event.endpoint),
    threadIdPresent: Boolean(event.threadId),
    registrationState: promptable ? "promptable" : "metadata-only",
  };
}

export function writePluginState(path: string | undefined, snapshot: CodexPluginEventSnapshot | undefined): void {
  if (!path || !snapshot) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ lastEvent: snapshot }, null, 2)}\n`, "utf8");
}

export function readPluginState(path: string | undefined): { readonly lastEvent?: CodexPluginEventSnapshot } {
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.lastEvent)) return {};
    const lastEvent = parsed.lastEvent;
    if (typeof lastEvent.event !== "string" || typeof lastEvent.source !== "string" || typeof lastEvent.receivedAt !== "string") return {};
    const snapshot: CodexPluginEventSnapshot = {
      event: lastEvent.event,
      source: lastEvent.source,
      receivedAt: lastEvent.receivedAt,
      ...(typeof lastEvent.endpointFingerprint === "string" ? { endpointFingerprint: lastEvent.endpointFingerprint } : {}),
      endpointPresent: lastEvent.endpointPresent === true,
      threadIdPresent: lastEvent.threadIdPresent === true,
      registrationState: lastEvent.registrationState === "promptable" ? "promptable" : "metadata-only",
    };
    return { lastEvent: snapshot };
  } catch {
    return {};
  }
}

export async function emitCodexPluginNotification(opts: EmitCodexPluginNotificationOptions): Promise<{ readonly status: number; readonly body: string }> {
  const response = await fetch(new URL("/codex/plugin/events", opts.registrarUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-synadia-codex-registrar-token": opts.token,
    },
    body: JSON.stringify(opts.event),
  });
  return { status: response.status, body: await response.text() };
}

export function pluginStatus(config: CodexPluginConfig | undefined): CodexPluginStatus {
  const plugin = config ?? defaultPluginConfig();
  const state = readPluginState(plugin.statePath);
  const hookPath = plugin.hookPath;
  return {
    installed: !plugin.enabled || !hookPath || existsSync(hookPath),
    hookTrusted: !plugin.enabled || Boolean(plugin.registrarToken),
    registrarConfigured: !plugin.enabled || (isLoopbackHost(plugin.registrarHost) && plugin.registrarPort > 0),
    ...(plugin.enabled ? { registrarUrl: `http://${plugin.registrarHost}:${plugin.registrarPort}` } : {}),
    ...(state.lastEvent ? { lastEvent: state.lastEvent } : {}),
  };
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

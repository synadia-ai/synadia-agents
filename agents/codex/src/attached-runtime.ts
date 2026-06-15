import type { CodexBridgeClient, CodexBridgeEvent, CodexPromptRequest } from "./bridge.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { requireAttachedEndpointAuth } from "./endpoint.js";
import type { CodexChannelConfig } from "./types.js";

export interface AttachedPreflightReport {
  readonly initialized: boolean;
  readonly loadedThreadCount: number;
  readonly threadCount: number;
  readonly selectedThreadFound: boolean;
  readonly readOk: boolean;
  readonly resumeOk: boolean;
  readonly streamOk: boolean;
  readonly permissionMode: "external-owner";
}

export interface AttachedCodexRuntimeOptions {
  readonly config: CodexChannelConfig;
  readonly streamPreflightPrompt?: string;
  readonly turnTimeoutMs?: number;
}

export class AttachedCodexRuntime implements CodexBridgeClient {
  readonly mode = "attached" as const;
  readonly #opts: AttachedCodexRuntimeOptions;
  #client: CodexAppServerClient | undefined;
  #preflight: AttachedPreflightReport | undefined;

  constructor(opts: AttachedCodexRuntimeOptions) {
    this.#opts = opts;
  }

  get preflight(): AttachedPreflightReport | undefined { return this.#preflight; }

  async start(): Promise<AttachedPreflightReport> {
    if (this.#client && this.#preflight) return this.#preflight;
    const { endpoint, endpointAuth, threadId, publicAlias } = this.#requiredAttachedConfig();
    requireAttachedEndpointAuth(endpoint, endpointAuth);
    const endpointOpts: { endpoint: string; authToken?: string } = { endpoint };
    if (endpointAuth !== undefined) endpointOpts.authToken = endpointAuth;
    const client = await CodexAppServerClient.connectEndpoint(endpointOpts);
    const preflight = await preflightAttachedThread(client, {
      threadId,
      streamPrompt: this.#opts.streamPreflightPrompt ?? "Synadia Codex attached endpoint preflight: reply with ok.",
      turnTimeoutMs: this.#opts.turnTimeoutMs ?? 120_000,
    });
    if (!preflight.selectedThreadFound) {
      await client.close();
      throw new Error("attached thread id was not present in thread/loaded/list or thread/list inventory");
    }
    this.#client = client;
    this.#preflight = preflight;
    if (publicAlias !== this.#opts.config.agent.session) {
      throw new Error("attached mode must register the safe public alias as the public session");
    }
    return preflight;
  }

  async *prompt(input: CodexPromptRequest): AsyncIterable<CodexBridgeEvent> {
    await this.start();
    const client = this.#client;
    if (!client) throw new Error("Attached Codex runtime failed to start");
    yield { type: "status", text: "attached Codex app-server ready; permission_mode=external-owner" };
    for await (const event of client.turn(input.prompt, { timeoutMs: this.#opts.turnTimeoutMs ?? 120_000 })) {
      yield event;
    }
    yield { type: "done" };
  }

  async close(): Promise<void> {
    await this.#client?.close();
    this.#client = undefined;
    this.#preflight = undefined;
  }

  #requiredAttachedConfig(): { endpoint: string; endpointAuth?: string; threadId: string; publicAlias: string } {
    const endpoint = this.#opts.config.codex.endpoint;
    const threadId = this.#opts.config.codex.threadId;
    const publicAlias = this.#opts.config.codex.publicAlias;
    if (!endpoint) throw new Error("attached mode requires --endpoint or SYNADIA_CODEX_ENDPOINT");
    if (!threadId) throw new Error("attached mode requires --thread-id or SYNADIA_CODEX_THREAD_ID");
    if (!publicAlias) throw new Error("attached mode requires --alias/--public-alias or SYNADIA_CODEX_PUBLIC_ALIAS");
    const out: { endpoint: string; endpointAuth?: string; threadId: string; publicAlias: string } = { endpoint, threadId, publicAlias };
    if (this.#opts.config.codex.endpointAuth !== undefined) out.endpointAuth = this.#opts.config.codex.endpointAuth;
    return out;
  }
}

export async function preflightAttachedThread(
  client: CodexAppServerClient,
  opts: { readonly threadId: string; readonly streamPrompt: string; readonly turnTimeoutMs: number },
): Promise<AttachedPreflightReport> {
  await client.initialize();
  const loaded = await client.listLoadedThreads();
  const listed = await client.listThreads();
  const selectedThreadFound = [...loaded, ...listed].some((thread) => thread.id === opts.threadId || thread.threadId === opts.threadId);
  await client.readThread(opts.threadId);
  await client.resumeThread(opts.threadId);
  let streamOk = false;
  for await (const event of client.turn(opts.streamPrompt, { timeoutMs: opts.turnTimeoutMs })) {
    if (event.type === "response" || event.type === "status") streamOk = true;
  }
  return {
    initialized: true,
    loadedThreadCount: loaded.length,
    threadCount: listed.length,
    selectedThreadFound,
    readOk: true,
    resumeOk: true,
    streamOk,
    permissionMode: "external-owner",
  };
}

import type { NatsConnection } from "@nats-io/nats-core";
import type { AgentService } from "@synadia-ai/agent-service";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { EndpointRegistry, type EndpointRegistryEntry } from "./endpoint-registry.js";
import { derivePublicSessionAlias } from "./identity.js";
import { discoverEndpointSessions, type EligibleSessionRow } from "./session-inventory.js";
import { createCodexAgentService } from "./service.js";
import type { CodexBridgeClient, CodexBridgeEvent, CodexPromptRequest } from "./bridge.js";
import type { CodexChannelConfig } from "./types.js";

export type CodexEndpointClientFactory = (entry: EndpointRegistryEntry) => Promise<CodexAppServerClient>;

export interface CodexSessionManagerOptions {
  readonly nc: NatsConnection;
  readonly config: CodexChannelConfig;
  readonly version: string;
  readonly registry?: EndpointRegistry;
  readonly clientFactory?: CodexEndpointClientFactory;
  readonly turnTimeoutMs?: number;
}

export interface ManagedSessionSnapshot {
  readonly privateKey: string;
  readonly endpointFingerprint: string;
  readonly publicAlias: string;
  readonly promptSubject: string;
  readonly statusSubject: string;
  readonly heartbeatSubject: string;
}

interface RunningSession {
  readonly row: EligibleSessionRow;
  readonly alias: string;
  readonly service: AgentService;
  readonly client: SessionScopedCodexClient;
}

export class CodexSessionManager {
  readonly #opts: CodexSessionManagerOptions;
  readonly #running = new Map<string, RunningSession>();
  #registry: EndpointRegistry | undefined;

  constructor(opts: CodexSessionManagerOptions) { this.#opts = opts; }

  get snapshots(): ManagedSessionSnapshot[] {
    return [...this.#running.values()].map((session) => ({
      privateKey: session.row.privateKey,
      endpointFingerprint: session.row.endpointFingerprint,
      publicAlias: session.alias,
      promptSubject: session.service.subject.prompt,
      statusSubject: session.service.subject.status,
      heartbeatSubject: session.service.subject.heartbeat,
    })).sort((a, b) => a.publicAlias.localeCompare(b.publicAlias));
  }

  async start(): Promise<ManagedSessionSnapshot[]> {
    if (!this.#opts.config.manager.enabled && this.#opts.config.codex.mode !== "manager") {
      throw new Error("session manager requires codex.mode=manager or manager.enabled=true");
    }
    if (!this.#opts.config.manager.autoExposeCurrentSessions) {
      throw new Error("session manager requires auto_expose_current_sessions=true for current-session registration");
    }
    await this.reconcile();
    return this.snapshots;
  }

  async reconcile(): Promise<ManagedSessionSnapshot[]> {
    const registry = this.#registry ?? this.#opts.registry ?? EndpointRegistry.fromConfig(this.#opts.config);
    this.#registry = registry;
    const eligibleRows: EligibleSessionRow[] = [];
    for (const entry of registry.list()) {
      const inventoryClient = await this.#createClient(entry);
      try {
        const rows = await discoverEndpointSessions({ client: inventoryClient, endpoint: entry.endpoint, manager: this.#opts.config.manager });
        eligibleRows.push(...rows.filter((row) => row.eligible));
      } finally {
        await inventoryClient.close();
      }
    }

    const aliasByPrivateKey = allocateAliases(eligibleRows, registry.list());
    const wantedKeys = new Set(eligibleRows.map((row) => row.privateKey));
    for (const [privateKey, running] of [...this.#running]) {
      if (!wantedKeys.has(privateKey)) {
        await running.service.stop();
        await running.client.close();
        this.#running.delete(privateKey);
      }
    }
    for (const row of eligibleRows) {
      if (this.#running.has(row.privateKey)) continue;
      const entry = registry.list().find((candidate) => candidate.endpoint === row.endpoint);
      if (!entry) throw new Error("internal manager error: endpoint disappeared during reconcile");
      const alias = aliasByPrivateKey.get(row.privateKey);
      if (!alias) throw new Error("internal manager error: missing alias allocation");
      const appClient = await this.#createClient(entry);
      await appClient.initialize();
      await appClient.resumeThread(row.rawThreadId);
      const scopedClient = new SessionScopedCodexClient(appClient, row.rawThreadId, alias, this.#opts.turnTimeoutMs ?? 120_000);
      const config = withSession(this.#opts.config, alias);
      const service = createCodexAgentService({
        nc: this.#opts.nc,
        config,
        version: this.#opts.version,
        client: scopedClient,
        extraMetadata: {
          codex_mode: "manager",
          endpoint_fingerprint: row.endpointFingerprint,
          permission_mode: config.codex.permissionPolicy === "query" ? "query" : "external-owner",
        },
      });
      await service.start();
      this.#running.set(row.privateKey, { row, alias, service, client: scopedClient });
    }
    return this.snapshots;
  }

  async stop(): Promise<void> {
    for (const running of [...this.#running.values()].reverse()) {
      await running.service.stop();
      await running.client.close();
    }
    this.#running.clear();
  }

  async #createClient(entry: EndpointRegistryEntry): Promise<CodexAppServerClient> {
    if (this.#opts.clientFactory) return await this.#opts.clientFactory(entry);
    const opts: { endpoint: string; authToken?: string } = { endpoint: entry.endpoint };
    if (entry.authToken !== undefined) opts.authToken = entry.authToken;
    return await CodexAppServerClient.connectEndpoint(opts);
  }
}

export function allocateAliases(rows: readonly EligibleSessionRow[], entries: readonly EndpointRegistryEntry[]): Map<string, string> {
  const entryByEndpoint = new Map(entries.map((entry) => [entry.endpoint, entry]));
  const aliases = new Map<string, string>();
  const used = new Map<string, string>();
  for (const row of rows) {
    const entry = entryByEndpoint.get(row.endpoint);
    const explicitAlias = entry?.explicitAliases?.[row.rawThreadId];
    const identityInput = explicitAlias === undefined
      ? { endpoint: row.endpoint, rawThreadId: row.rawThreadId }
      : { endpoint: row.endpoint, rawThreadId: row.rawThreadId, explicitAlias };
    const alias = derivePublicSessionAlias(identityInput);
    const previous = used.get(alias);
    if (previous && previous !== row.privateKey) {
      if (explicitAlias || rows.some((candidate) => candidate.privateKey === previous && entryByEndpoint.get(candidate.endpoint)?.explicitAliases?.[candidate.rawThreadId])) {
        throw new Error(`explicit manager alias collision for ${alias}`);
      }
      throw new Error(`derived manager alias collision for ${alias}`);
    }
    used.set(alias, row.privateKey);
    aliases.set(row.privateKey, alias);
  }
  return aliases;
}

class SessionScopedCodexClient implements CodexBridgeClient {
  readonly mode = "manager" as const;
  readonly #client: CodexAppServerClient;
  readonly #rawThreadId: string;
  readonly #publicAlias: string;
  readonly #turnTimeoutMs: number;

  constructor(client: CodexAppServerClient, rawThreadId: string, publicAlias: string, turnTimeoutMs: number) {
    this.#client = client;
    this.#rawThreadId = rawThreadId;
    this.#publicAlias = publicAlias;
    this.#turnTimeoutMs = turnTimeoutMs;
  }

  async *prompt(input: CodexPromptRequest): AsyncIterable<CodexBridgeEvent> {
    if (input.publicSession !== this.#publicAlias) throw new Error("manager prompt session mismatch");
    await this.#client.resumeThread(this.#rawThreadId);
    yield { type: "status", text: "manager Codex app-server session ready; permission_mode=external-owner" };
    for await (const event of this.#client.turn(input.prompt, { timeoutMs: this.#turnTimeoutMs })) yield event;
    yield { type: "done" };
  }

  async close(): Promise<void> { await this.#client.close(); }
}

function withSession(config: CodexChannelConfig, session: string): CodexChannelConfig {
  return {
    ...config,
    agent: { ...config.agent, session },
    codex: { ...config.codex, mode: "manager", publicAlias: session },
    manager: { ...config.manager, enabled: true },
  };
}

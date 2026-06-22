import type { NatsConnection } from "@nats-io/nats-core";
import type { AgentService } from "@synadia-ai/agent-service";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { EndpointRegistry, type EndpointRegistryEntry } from "./endpoint-registry.js";
import { derivePublicSessionAlias } from "./identity.js";
import { discoverEndpointSessions, type EligibleSessionRow } from "./session-inventory.js";
import { BoundedPollScheduler } from "./session-watch.js";
import { createCodexAgentService } from "./service.js";
import { CodexPluginRegistrar, defaultPluginConfig, pluginEventSnapshot, writePluginState, type CodexPluginEventRecord } from "./plugin-registrar.js";
import type { CodexBridgeClient, CodexBridgeEvent, CodexPromptRequest } from "./bridge.js";
import type { CodexChannelConfig } from "./types.js";

export type CodexEndpointClientFactory = (entry: EndpointRegistryEntry) => Promise<CodexAppServerClient>;
export type ManagedSessionState = "active" | "stale";

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
  readonly state: ManagedSessionState;
  readonly staleMisses: number;
}

interface RunningSession {
  readonly row: EligibleSessionRow;
  readonly alias: string;
  readonly service: AgentService;
  readonly client: SessionScopedCodexClient;
  readonly state: ManagedSessionState;
  readonly staleMisses: number;
}

interface ReconcileOptions {
  readonly seedOnly?: boolean;
}

interface EndpointWatch {
  readonly client: CodexAppServerClient;
  readonly unsubscribe: () => void;
}

export class CodexSessionManager {
  readonly #opts: CodexSessionManagerOptions;
  readonly #running = new Map<string, RunningSession>();
  readonly #baselineEligiblePrivateKeys = new Set<string>();
  readonly #exposedPrivateKeys = new Set<string>();
  readonly #rememberedAliases = new Map<string, string>();
  readonly #endpointWatches: EndpointWatch[] = [];
  #registry: EndpointRegistry | undefined;
  #poller: BoundedPollScheduler | undefined;
  #pluginRegistrar: CodexPluginRegistrar | undefined;
  #lastPluginEvent: CodexPluginEventRecord | undefined;
  #endpointErrorCount = 0;
  #started = false;

  constructor(opts: CodexSessionManagerOptions) { this.#opts = opts; }

  get snapshots(): ManagedSessionSnapshot[] {
    return [...this.#running.values()].map((session) => ({
      privateKey: session.row.privateKey,
      endpointFingerprint: session.row.endpointFingerprint,
      publicAlias: session.alias,
      promptSubject: session.service.subject.prompt,
      statusSubject: session.service.subject.status,
      heartbeatSubject: session.service.subject.heartbeat,
      state: session.state,
      staleMisses: session.staleMisses,
    })).sort((a, b) => a.publicAlias.localeCompare(b.publicAlias));
  }

  async start(): Promise<ManagedSessionSnapshot[]> {
    if (!this.#opts.config.manager.enabled && this.#opts.config.codex.mode !== "manager") {
      throw new Error("session manager requires codex.mode=manager or manager.enabled=true");
    }
    if (!this.#opts.config.manager.autoExposeCurrentSessions && !this.#opts.config.manager.autoExposeFutureSessions) {
      throw new Error("session manager requires auto_expose_current_sessions=true or auto_expose_future_sessions=true");
    }
    this.#started = true;
    if (this.#opts.config.manager.autoExposeCurrentSessions) await this.reconcile();
    else await this.reconcile({ seedOnly: true });
    if (this.#opts.config.manager.autoExposeFutureSessions) await this.#startFutureWatch();
    await this.#startPluginRegistrar();
    return this.snapshots;
  }

  async rescan(): Promise<ManagedSessionSnapshot[]> {
    return await this.reconcile();
  }

  get pluginLastEvent(): CodexPluginEventRecord | undefined { return this.#lastPluginEvent; }
  get endpointErrorCount(): number { return this.#endpointErrorCount; }

  async notifyPluginEvent(event: CodexPluginEventRecord): Promise<ManagedSessionSnapshot[]> {
    await this.#recordPluginEvent(event);
    return this.snapshots;
  }

  async reconcile(opts: ReconcileOptions = {}): Promise<ManagedSessionSnapshot[]> {
    const registry = this.#registry ?? this.#opts.registry ?? EndpointRegistry.fromConfig(this.#opts.config);
    this.#registry = registry;
    const entries = registry.list();
    const eligibleRows = await this.#discoverEligibleRows(entries);
    const aliasByPrivateKey = allocateAliases(eligibleRows, entries);
    const wantedKeys = new Set(eligibleRows.map((row) => row.privateKey));

    for (const row of eligibleRows) {
      const running = this.#running.get(row.privateKey);
      if (running) {
        this.#rememberedAliases.set(row.privateKey, running.alias);
        this.#running.set(row.privateKey, { ...running, row, state: "active", staleMisses: 0 });
        continue;
      }

      const alias = this.#rememberedAliases.get(row.privateKey) ?? aliasByPrivateKey.get(row.privateKey);
      if (!alias) throw new Error("internal manager error: missing alias allocation");
      this.#rememberedAliases.set(row.privateKey, alias);
      const shouldExpose = !opts.seedOnly && this.#shouldExposeRow(row);
      if (shouldExpose) await this.#startSession(row, alias, entries);
      else this.#baselineEligiblePrivateKeys.add(row.privateKey);
    }

    for (const [privateKey, running] of [...this.#running]) {
      if (wantedKeys.has(privateKey)) continue;
      const staleMisses = running.staleMisses + 1;
      if (staleMisses >= this.#opts.config.manager.staleGraceIntervals) {
        await this.#stopRunning(privateKey, running);
      } else {
        this.#running.set(privateKey, { ...running, state: "stale", staleMisses });
      }
    }
    return this.snapshots;
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#poller?.stop();
    this.#poller = undefined;
    await this.#pluginRegistrar?.stop().catch(() => undefined);
    this.#pluginRegistrar = undefined;
    for (const watch of this.#endpointWatches.splice(0).reverse()) {
      watch.unsubscribe();
      await watch.client.close().catch(() => undefined);
    }
    for (const [privateKey, running] of [...this.#running].reverse()) {
      await this.#stopRunning(privateKey, running);
    }
    this.#running.clear();
  }

  async #discoverEligibleRows(entries: readonly EndpointRegistryEntry[]): Promise<EligibleSessionRow[]> {
    const eligibleRows: EligibleSessionRow[] = [];
    this.#endpointErrorCount = 0;
    for (const entry of entries) {
      let inventoryClient: CodexAppServerClient | undefined;
      try {
        inventoryClient = await this.#createClient(entry);
        const rows = await discoverEndpointSessions({ client: inventoryClient, endpoint: entry.endpoint, manager: this.#opts.config.manager });
        eligibleRows.push(...rows.filter((row) => row.eligible));
      } catch {
        this.#endpointErrorCount += 1;
        // Endpoint loss is handled by the stale state machine below. Do not log
        // endpoint URLs/socket paths here; those are private local identifiers.
      } finally {
        await inventoryClient?.close().catch(() => undefined);
      }
    }
    return eligibleRows;
  }

  #shouldExposeRow(row: EligibleSessionRow): boolean {
    if (this.#opts.config.manager.autoExposeCurrentSessions) return true;
    if (!this.#opts.config.manager.autoExposeFutureSessions) return false;
    if (this.#exposedPrivateKeys.has(row.privateKey)) return true;
    return !this.#baselineEligiblePrivateKeys.has(row.privateKey);
  }

  async #startSession(row: EligibleSessionRow, alias: string, entries: readonly EndpointRegistryEntry[]): Promise<void> {
    const entry = entries.find((candidate) => candidate.endpoint === row.endpoint);
    if (!entry) throw new Error("internal manager error: endpoint disappeared during reconcile");
    const appClient = await this.#createClient(entry);
    try {
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
      this.#exposedPrivateKeys.add(row.privateKey);
      this.#rememberedAliases.set(row.privateKey, alias);
      this.#running.set(row.privateKey, { row, alias, service, client: scopedClient, state: "active", staleMisses: 0 });
    } catch (err) {
      await appClient.close().catch(() => undefined);
      throw err;
    }
  }

  async #stopRunning(privateKey: string, running: RunningSession): Promise<void> {
    this.#rememberedAliases.set(privateKey, running.alias);
    await running.service.stop();
    await this.#opts.nc.flush();
    await running.client.close();
    this.#running.delete(privateKey);
  }

  async #startFutureWatch(): Promise<void> {
    const registry = this.#registry ?? this.#opts.registry ?? EndpointRegistry.fromConfig(this.#opts.config);
    this.#registry = registry;
    this.#poller = new BoundedPollScheduler(this.#opts.config.manager.watchIntervalMs, async () => {
      if (this.#started) await this.reconcile();
    });
    this.#poller.start();

    if (this.#opts.config.manager.watchMode !== "event-plus-poll") return;
    for (const entry of registry.list()) {
      try {
        const client = await this.#createClient(entry);
        await client.initialize();
        const unsubscribe = client.onThreadStarted(() => { void this.#poller?.trigger(); });
        this.#endpointWatches.push({ client, unsubscribe });
      } catch {
        // Polling remains the recovery path. Avoid logging private endpoint data.
      }
    }
  }

  async #startPluginRegistrar(): Promise<void> {
    const plugin = this.#opts.config.plugin ?? defaultPluginConfig();
    if (!plugin.enabled) return;
    if (!plugin.registrarToken) throw new Error("plugin registrar requires plugin.registrar_token or SYNADIA_CODEX_PLUGIN_REGISTRAR_TOKEN");
    const registrar = new CodexPluginRegistrar({
      host: plugin.registrarHost,
      port: plugin.registrarPort,
      token: plugin.registrarToken,
      ...(plugin.statePath ? { statePath: plugin.statePath } : {}),
      onEvent: async (event) => { await this.#recordPluginEvent(event); },
    });
    registrar.start();
    this.#pluginRegistrar = registrar;
  }

  async #recordPluginEvent(event: CodexPluginEventRecord): Promise<void> {
    this.#lastPluginEvent = event;
    const plugin = this.#opts.config.plugin ?? defaultPluginConfig();
    const beforePromptable = event.privateKey ? this.#running.has(event.privateKey) : false;
    writePluginState(plugin.statePath, pluginEventSnapshot(event, beforePromptable));
    await this.reconcile();
    const afterPromptable = event.privateKey ? this.#running.has(event.privateKey) : false;
    writePluginState(plugin.statePath, pluginEventSnapshot(event, afterPromptable));
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

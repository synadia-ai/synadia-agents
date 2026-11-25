/**
 * Wires the extension: one NATS connection, the agent tools (outbound) and,
 * when enabled, an `AgentService` that serves fleet prompts in the session
 * through the {@link InboundBridge} (inbound).
 *
 * Independent of `@github/copilot-sdk` so tests drive it with a fake
 * session; `src/extension.ts` adapts the real one.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  AgentService,
  RequestRejectedError,
  type RequestInterceptor,
} from "@synadia-ai/agent-service";
import {
  AGENT_TOOL_NAMES,
  AgentSubject,
  AgentTools,
  Agents,
  BLOCKING_AGENT_TOOLS,
  SDK_PROTOCOL_VERSION,
  agentToolDefinitions,
  formatSender,
  resolveNatsConnectionBundle,
  withAgentReconnectDefaults,
  type AgentToolName,
  type Logger,
  type NatsConnectionBundle,
} from "@synadia-ai/agents";

import { InboundBridge, QueueFullError, BridgeClosedError, type BridgeAttachment, type BridgeSession } from "./bridge.js";
import { AGENT_ID, instanceName, senderAllowed, type Settings } from "./config.js";

export const EXTENSION_NAME = "synadia-nats";
export const EXTENSION_VERSION = "0.1.0";
export const PROTOCOL_VERSION = `${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`;

export type LogLevel = "info" | "warning" | "error";
export type Log = (message: string, level?: LogLevel) => void;

/** A tool in the shape `joinSession({ tools })` takes. */
export interface ExtensionTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly handler: (args: unknown, invocation: { toolCallId?: string }) => Promise<string>;
  /** Tool-search deferral (modern SDK); older hosts ignore it. */
  readonly defer?: "auto" | "never";
}

/**
 * The entry points the model must always see. Hosts with many tools defer
 * extension tools behind tool search, and smaller models then miss them; the
 * follow-up tools (answer, cancel, …) stay deferrable.
 */
const ALWAYS_LOADED = new Set<string>(["discover_agents", "prompt_agent"]);

/** A permission request as the CLI hands it to `onPermissionRequest`. */
export type PermissionRequestLike = { readonly kind?: string } & Readonly<Record<string, unknown>>;
export type PermissionDecision =
  | { kind: "no-result" }
  | { kind: "approve-once" }
  | { kind: "reject"; feedback?: string };

export interface ServedContext {
  readonly sender: string;
  readonly verified: boolean;
  readonly ask: (prompt: string, timeoutMs: number) => Promise<string>;
  readonly enter: <T>(fn: () => T) => T;
}

export interface RuntimeOptions {
  readonly settings: Settings;
  readonly log: Log;
  /** For tests: a connection to use instead of resolving one from the settings. */
  readonly nc?: NatsConnection;
}

export class ExtensionRuntime {
  readonly settings: Settings;
  readonly #log: Log;
  readonly #protocolLogger: Logger;
  readonly #injectedNc: NatsConnection | undefined;
  #connecting: Promise<Connected> | undefined;
  #connected: Connected | undefined;
  #bridge: InboundBridge | undefined;
  #service: AgentService | undefined;
  #stagingRoot: string | undefined;
  #sessionId: string | undefined;
  #started = false;
  #stopped = false;

  constructor(options: RuntimeOptions) {
    this.settings = options.settings;
    this.#log = options.log;
    this.#injectedNc = options.nc;
    this.#protocolLogger = protocolLogger((m, l) => this.#log(m, l));
  }

  /** The names of the agent tools offered, before any prefix. */
  get toolNames(): ReadonlyArray<AgentToolName> {
    switch (this.settings.agentTools) {
      case "all":
        return AGENT_TOOL_NAMES;
      case "blocking":
        return BLOCKING_AGENT_TOOLS;
      case "off":
        return [];
    }
  }

  /** The service's subject once inbound has started. */
  get promptSubject(): string | undefined {
    return this.#service?.subject.prompt;
  }

  get bridge(): InboundBridge | undefined {
    return this.#bridge;
  }

  /**
   * The agent tools as extension tools. Known before connecting (the
   * definitions are static), so they can be passed to `joinSession`; the
   * connection is made on first use if startup has not made it yet.
   *
   * No tool sets `skipPermission`: every call goes through the CLI's normal
   * tool approval, and the extension does not need the extra "skip tool
   * permission prompts" grant that newer CLIs gate extensions behind.
   */
  extensionTools(): ExtensionTool[] {
    const offered = new Set<string>(this.toolNames);
    return agentToolDefinitions()
      .filter((d) => offered.has(d.name))
      .map((d) => ({
        name: `${this.settings.toolPrefix}${d.name}`,
        description: `${d.description}\n\n(Synadia Agent Protocol for NATS fleet, via the ${EXTENSION_NAME} extension.)`,
        parameters: d.parameters as Record<string, unknown>,
        handler: (args, invocation) => this.executeTool(d.name, args, invocation.toolCallId),
        ...(ALWAYS_LOADED.has(d.name) ? { defer: "never" as const } : {}),
      }));
  }

  /** Run one agent tool; the result is the JSON text the model reads. */
  async executeTool(name: AgentToolName, args: unknown, toolCallId?: string): Promise<string> {
    let connected: Connected;
    try {
      connected = await this.connect();
    } catch (error) {
      return JSON.stringify({
        error: `not connected to NATS (${this.settings.connectionLabel}): ${errorText(error)}`,
      });
    }
    const tools = this.#ensureTools(connected);
    if (!tools) return JSON.stringify({ error: "agent tools are off (agentTools: off)" });
    const run = () => tools.execute(name, args ?? {}, toolCallId ? { toolCallId } : {});
    // A call made while a served prompt holds the turn runs in that prompt's
    // tools scope, so its calls are the caller's and close with its stream.
    const served = this.#bridge?.current()?.context as ServedContext | undefined;
    const result = await (served ? served.enter(run) : run());
    return JSON.stringify(result);
  }

  /** The agent tools on this connection, built on first need. */
  #ensureTools(connected: Connected): AgentTools | undefined {
    if (connected.tools || this.toolNames.length === 0) return connected.tools;
    // The session's own address is left out of discovery and refused, so
    // the model cannot prompt the session it runs in.
    const selfAddress = this.#sessionId
      ? AgentSubject.new(AGENT_ID, this.settings.owner, instanceName(this.settings, this.#sessionId)).prompt
      : undefined;
    connected.tools = new AgentTools({
      agents: connected.agents,
      tools: this.toolNames,
      ...(selfAddress ? { selfAddress } : {}),
      logger: this.#protocolLogger,
      attachmentRoots: [process.cwd()],
    });
    return connected.tools;
  }

  /** Connect (once). Concurrent callers share the attempt; a failure lets the next call retry. */
  connect(): Promise<Connected> {
    if (this.#stopped) return Promise.reject(new Error("extension stopped"));
    if (this.#connected) return Promise.resolve(this.#connected);
    this.#connecting ??= this.#doConnect().then(
      (c) => {
        this.#connected = c;
        return c;
      },
      (error: unknown) => {
        this.#connecting = undefined;
        throw error;
      },
    );
    return this.#connecting;
  }

  #doConnect(): Promise<Connected> {
    return openNatsConnection(this.settings, `copilot-${EXTENSION_NAME}`, this.#protocolLogger, this.#injectedNc);
  }

  /**
   * Start: connect, build the agent tools and, when inbound is enabled,
   * register the session on the fleet. `session.sessionId` names the
   * instance (`copilot-<first 8>` unless `name` is set).
   */
  async start(session: BridgeSession & { readonly sessionId: string }): Promise<void> {
    if (this.#service || this.#started) return;
    this.#sessionId = session.sessionId;
    const connected = await this.connect();
    if (this.#started) return;
    this.#started = true;
    const owner = this.settings.owner;
    const name = instanceName(this.settings, session.sessionId);
    this.#ensureTools(connected);
    if (!this.settings.inbound.enabled) {
      this.#log(
        `synadia-nats: connected (${this.settings.connectionLabel}); outbound tools: ${this.toolNames.join(", ") || "none"}; inbound off`,
      );
      return;
    }

    const bridge = new InboundBridge(session, {
      queueLimit: this.settings.inbound.queueLimit,
      log: (m) => this.#log(m, "warning"),
    });
    this.#bridge = bridge;
    const stagingRoot = join(tmpdir(), "copilot-synadia-nats", name);
    this.#stagingRoot = stagingRoot;
    const allow = this.settings.inbound.allowSenders;
    const queueLimit = this.settings.inbound.queueLimit;

    const admission: RequestInterceptor = {
      aroundRequest: (_ctx, next) => {
        if (this.#stopped) throw new RequestRejectedError(503, "Copilot session is shutting down");
        if (bridge.queued >= queueLimit) {
          throw new RequestRejectedError(503, `Copilot session is busy; ${queueLimit} prompt(s) queued`);
        }
        return next();
      },
    };

    const service = new AgentService({
      nc: connected.nc,
      agent: AGENT_ID,
      owner,
      name,
      session: session.sessionId,
      description: this.settings.description ?? `GitHub Copilot session ${name}`,
      version: EXTENSION_VERSION,
      attachmentsOk: true,
      heartbeatIntervalS: 5,
      keepaliveIntervalS: 30,
      minSenderTrust: this.settings.inbound.minSenderTrust,
      ...(allow.length > 0
        ? { acceptSender: (sender) => sender?.trust === "verified" && senderAllowed(allow, sender.id) }
        : {}),
      logger: this.#protocolLogger,
      interceptors: [admission, ...(connected.tools ? [connected.tools.requestInterceptor] : [])],
      heartbeatExtras: () => ({
        busy: bridge.busy || bridge.current() !== undefined,
        queued: bridge.queued,
      }),
      extraMetadata: { harness: "github-copilot-cli-extension" },
      ...connected.identity,
    });

    let sequence = 0;
    service.onPrompt(async (envelope, response) => {
      const requestId = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
      const sender = response.sender;
      const senderLabel = formatSender(sender);
      const attachments = stageAttachments(stagingRoot, requestId, envelope.attachments);
      const served: ServedContext = {
        sender: senderLabel,
        verified: sender?.trust === "verified",
        ask: async (prompt, timeoutMs) => (await response.ask(prompt, { timeoutMs })).prompt,
        enter: AsyncLocalStorage.snapshot(),
      };
      this.#log(`synadia-nats: prompt from ${senderLabel} (${envelope.prompt.length} chars)`);
      try {
        await bridge.serve({
          prompt: framePrompt(envelope.prompt, senderLabel, attachments),
          attachments,
          response,
          context: served,
        });
      } catch (error) {
        if (error instanceof QueueFullError || error instanceof BridgeClosedError) {
          throw new RequestRejectedError(503, error.message);
        }
        throw error;
      }
    });

    try {
      await service.start();
    } catch (error) {
      bridge.close("inbound failed to start");
      this.#bridge = undefined;
      this.#started = false;
      throw error;
    }
    this.#service = service;
    this.#log(
      `synadia-nats: inbound ON at ${service.subject.prompt} (min_sender_trust=${this.settings.inbound.minSenderTrust}` +
        `${allow.length > 0 ? `, ${allow.length} allowed sender(s)` : ""}, permissions=${this.settings.inbound.permissions}); ` +
        `outbound tools: ${this.toolNames.join(", ") || "none"}`,
    );
  }

  /**
   * `onPermissionRequest`: with `permissions: "query"`, a request raised
   * while a verified sender's prompt holds the turn is asked of that
   * caller; everything else stays with the local UI (`no-result`).
   * Nothing is ever approved without an explicit yes.
   */
  async decidePermission(request: PermissionRequestLike): Promise<PermissionDecision> {
    if (this.settings.inbound.permissions !== "query") return { kind: "no-result" };
    const served = this.#bridge?.current()?.context as ServedContext | undefined;
    if (!served || !served.verified) return { kind: "no-result" };
    let reply: string;
    try {
      reply = await served.ask(describePermission(request), this.settings.inbound.permissionTimeoutMs);
    } catch (error) {
      return { kind: "reject", feedback: `remote caller did not answer: ${errorText(error)}` };
    }
    return parseApproval(reply)
      ? { kind: "approve-once" }
      : { kind: "reject", feedback: `denied by remote caller ${served.sender}` };
  }

  /** Stop serving, drain the connection, wipe credentials. Idempotent. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#bridge?.close("Copilot session ended");
    await this.#service?.stop().catch(() => undefined);
    const connected = this.#connected ?? (await this.#connecting?.catch(() => undefined));
    await connected?.tools?.close().catch(() => undefined);
    if (connected && !this.#injectedNc) await connected.nc.drain().catch(() => undefined);
    connected?.bundle?.wipe();
    if (this.#stagingRoot) rmSync(this.#stagingRoot, { recursive: true, force: true });
  }
}

export interface Connected {
  readonly nc: NatsConnection;
  readonly bundle: NatsConnectionBundle | undefined;
  readonly agents: Agents;
  /** `{ identity: { signer } }` when prompts and replies are signed, else `{}`. */
  readonly identity: Record<string, unknown>;
  tools: AgentTools | undefined;
}

/**
 * One NATS connection from the settings (or the injected one): fail fast on
 * the first connect, reconnect forever after, credentials wiped on failure.
 */
export async function openNatsConnection(
  settings: Pick<Settings, "connectionSource" | "senderIdentity">,
  connectionName: string,
  logger: Logger,
  injected?: NatsConnection,
): Promise<Connected> {
  let bundle: NatsConnectionBundle | undefined;
  let nc = injected;
  if (!nc) {
    bundle = await resolveNatsConnectionBundle(settings.connectionSource, { identity: settings.senderIdentity });
    bundle.connectionOptions.name = connectionName;
    try {
      nc = await connect(withAgentReconnectDefaults({ ...bundle.connectionOptions, waitOnFirstConnect: false }));
    } catch (error) {
      bundle.wipe();
      throw error;
    }
  }
  const signer = bundle?.signer;
  const identity = settings.senderIdentity === "signed" && signer ? { identity: { signer } } : {};
  const agents = new Agents({ nc, logger, ...identity });
  return { nc, bundle, agents, identity, tools: undefined };
}

/** A protocol logger that keeps warnings and errors. */
export function protocolLogger(log: Log): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, ctx) => log(`synadia-nats: ${msg}${ctx ? ` ${safeJson(ctx)}` : ""}`, "warning"),
    error: (msg, ctx) => log(`synadia-nats: ${msg}${ctx ? ` ${safeJson(ctx)}` : ""}`, "error"),
  };
}

/** The text sent into the session for a served prompt. */
export function framePrompt(prompt: string, sender: string, attachments: ReadonlyArray<BridgeAttachment>): string {
  const files = attachments.length > 0
    ? `\nAttached files: ${attachments.map((a) => a.path).join(", ")}`
    : "";
  return (
    `[Remote prompt from the NATS agent fleet — sender ${sender}. ` +
    `Your reply in this turn is streamed back to that caller.]${files}\n\n${prompt}`
  );
}

/** One line a remote caller can answer yes or no to. */
export function describePermission(request: PermissionRequestLike): string {
  const kind = typeof request.kind === "string" ? request.kind : "unknown";
  const fields = ["fullCommandText", "intention", "fileName", "path", "url", "toolName", "serverName", "diff"];
  const details = fields
    .map((f) => (typeof request[f] === "string" && request[f] ? `${f}: ${truncate(String(request[f]), 400)}` : undefined))
    .filter(Boolean)
    .join("; ");
  return `Copilot requests permission (${kind})${details ? ` — ${details}` : ""}. Reply "yes" to allow once, anything else denies.`;
}

export function parseApproval(reply: string): boolean {
  return /^(y|yes|allow|approve|ok)$/i.test(reply.trim());
}

/** Write a prompt's attachments under `root/<requestId>/` with safe names. */
export function stageAttachments(
  root: string,
  requestId: string,
  attachments: ReadonlyArray<{ readonly filename: string; readonly content: Uint8Array }> | undefined,
): BridgeAttachment[] {
  if (!attachments || attachments.length === 0) return [];
  const dir = join(root, requestId);
  mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  return attachments.map((a, i) => {
    let safe = basename(a.filename.replace(/\\/g, "/")).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
    if (!safe) safe = `attachment-${i + 1}`;
    while (used.has(safe)) safe = `${i + 1}-${safe}`;
    used.add(safe);
    const path = join(dir, safe);
    writeFileSync(path, a.content);
    return { type: "file" as const, path, displayName: safe };
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

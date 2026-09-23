import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/nats-core";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  Agents,
  AgentSubject,
  AgentTools,
  formatSender,
  type Logger,
  type NatsConnectionBundle,
  type RequestEnvelope,
} from "@synadia-ai/agents";
import {
  AgentService,
  DEFAULT_ATTACHMENTS_OK,
  splitResponseText,
  type PromptResponse,
  type RequestInterceptor,
} from "@synadia-ai/agent-service";
import {
  ACK_KEEPALIVE_MS,
  AGENT_ID,
  DEFAULT_SESSION,
  SERVICE_VERSION,
  SUBJECT_AGENT_TOKEN,
} from "./nats/index.js";
import { connectToNats, drainConnection } from "./nats/connection.js";
import type { ResolvedNatsAccount } from "./types.js";
import {
  getNatsRuntime,
  setActiveAgentTools,
  setActiveConnection,
  setActiveExtensions,
} from "./runtime.js";
import {
  cleanupAgentStaging,
  stageAttachmentsIntoPrompt,
} from "./attachments.js";
import {
  composeExtensions,
  loadExtensions,
  type ComposedExtensions,
  type Outcome,
  type ServedRequest,
} from "./extensions.js";
import { registerAgentTools, toolNamesFor, type ActiveTurn } from "./tools.js";

// Stage attachments under OpenClaw's media-access allowlist.
const ATTACHMENT_BASE_DIR = join(resolveStateDir(), "media", "nats-channel");
const HEARTBEAT_INTERVAL_S = 5;

// What an extension's factory is told about the plugin that loads it.
const PLUGIN_NAME = "@synadia-ai/nats-channel";
const PLUGIN_VERSION = readPluginVersion();

function readPluginVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

// One OpenClaw channel account runs at a time.
let activeService: AgentService | null = null;
let activeNc: NatsConnection | null = null;
let activeBundle: NatsConnectionBundle | null = null;
let activeAgentName: string | null = null;
// The caller-side client the agent tools prompt through, and the tools
// themselves; both live as long as the service. `activeTools` stays null
// with `agentTools: "off"`.
let activeAgents: Agents | null = null;
let activeTools: AgentTools | null = null;
// The account's extensions, loaded before the connection; the composition
// of none until then.
let activeExtensions: ComposedExtensions | null = null;

// ───────────────────────────────────────────────────────────────────────
// The served turns: which request a tool call belongs to
// ───────────────────────────────────────────────────────────────────────

/** A served prompt from its arrival until OpenClaw's dispatch settled. */
interface Turn {
  readonly served: ServedRequest;
  /** Runs a function in the prompt handler's async context (see `activeTurn`). */
  readonly enter: <T>(fn: () => T) => T;
}

// The prompt handler runs inside `turnStore`, so a tool call made in the
// handler's async context finds its request here. OpenClaw carries that
// context into the turn it dispatches on 2026.8 and later (its command lane
// snapshots the enqueuer's `AsyncLocalStorage` state); on earlier releases
// the turn runs in the lane's own context and the store is empty there.
const turnStore = new AsyncLocalStorage<ServedRequest>();
// Every served prompt whose dispatch is pending, in arrival order. OpenClaw
// runs one turn at a time per session — all of an account's prompts share
// one — and dispatches in order, so the oldest pending turn is the one its
// model is working in.
let turnsInFlight: Turn[] = [];
let turnCounter = 0;

/**
 * The turn OpenClaw's model is working in when a tool runs: the one bound
 * in the current async context when the context reached the tool, else
 * the oldest dispatch still pending. `enter` puts a tool call back into
 * that request's async context — the interceptors' bindings and the tools'
 * scope — when the tool runner lost it; it is a no-op when the context is
 * already the request's.
 */
function activeTurn(): ActiveTurn | undefined {
  const bound = turnStore.getStore();
  if (bound) return { served: bound, enter: (fn) => fn() };
  const head = turnsInFlight[0];
  return head ? { served: head.served, enter: head.enter } : undefined;
}

/** The request as the extensions' events name it; one object per request. */
function servedRequest(envelope: RequestEnvelope, response: PromptResponse): ServedRequest {
  const sender = response.sender;
  return Object.freeze({
    id: String(++turnCounter),
    extras: Object.freeze({ ...(envelope.extras ?? {}) }),
    ...(sender?.trust === "verified" ? { caller: String(sender.id) } : {}),
  });
}

async function cleanupPrevious(): Promise<void> {
  // The extensions hear of the stop before the service leaves the bus.
  if (activeService && activeExtensions) {
    await activeExtensions.stopping();
  }
  activeExtensions = null;
  setActiveExtensions(null);
  if (activeService) {
    try {
      await activeService.stop();
    } catch {}
    activeService = null;
  }
  turnsInFlight = [];
  setActiveAgentTools(null);
  if (activeTools) {
    try {
      await activeTools.close();
    } catch {}
    activeTools = null;
  }
  if (activeAgents) {
    try {
      await activeAgents.close();
    } catch {}
    activeAgents = null;
  }
  if (activeNc) {
    // Do not wipe or replace this connection's credential snapshot unless the
    // connection is definitely closed. drainConnection forces close on a
    // graceful-drain failure and throws only when even that close failed.
    await drainConnection(activeNc);
    activeNc = null;
  }
  // Reconnect authentication and the sender signer share this retained
  // snapshot. It is safe to wipe only after the NATS connection has closed.
  activeBundle?.wipe();
  activeBundle = null;
  if (activeAgentName) {
    cleanupAgentStaging(ATTACHMENT_BASE_DIR, activeAgentName);
    activeAgentName = null;
  }
  setActiveConnection(null, null, null);
}

/**
 * Load the account's extensions, once, before the connection. A module
 * that fails is logged and skipped; the gateway starts plain with the rest.
 */
async function loadAccountExtensions(
  account: ResolvedNatsAccount,
  logger: Logger,
): Promise<ComposedExtensions> {
  if (account.extensions.entries.length === 0) {
    return composeExtensions([], logger);
  }
  const loaded = await loadExtensions(
    account.extensions.entries,
    {
      harness: "openclaw",
      plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      settings: {
        owner: account.owner,
        name: account.agentName,
        senderIdentity: account.senderIdentity,
        minSenderTrust: account.minSenderTrust,
        stateDir: resolveStateDir(),
        config: Object.freeze({ ...(account.config as unknown as Record<string, unknown>) }),
      },
      logger,
    },
    logger,
  );
  return composeExtensions(loaded, logger);
}

export async function startNatsGateway(
  ctx: ChannelGatewayContext<ResolvedNatsAccount>,
): Promise<void> {
  const { account, cfg, abortSignal, channelRuntime } = ctx;
  const agentName = account.agentName;
  const sourceLabel =
    "context" in account.connectionSource
      ? `context ${JSON.stringify(account.connectionSource.context)}`
      : "configured URL";

  await cleanupPrevious();

  const logger = gatewayLogger(ctx);
  const extensions = await loadAccountExtensions(account, logger);
  activeExtensions = extensions;
  setActiveExtensions({ accountId: account.accountId, names: extensions.names });

  ctx.log?.info?.(
    `nats: gateway starting — oc/${account.owner}/${agentName} using ${sourceLabel} ` +
      `(accountId: ${account.accountId}, senderIdentity: ${account.senderIdentity}, ` +
      `minSenderTrust: ${account.minSenderTrust}, agentTools: ${account.agentTools}, ` +
      `extensions: ${extensions.names.join(", ") || "none"})`,
  );

  const connected = await connectToNats({
    source: account.connectionSource,
    senderIdentity: account.senderIdentity,
    name: `openclaw-${agentName}`,
  });
  activeNc = connected.nc;
  activeBundle = connected.bundle;
  activeAgentName = agentName;

  const signer = connected.bundle.signer;
  // One caller-side client for the agent tools, with the same signer as the
  // service and the extensions' prompt interceptors. It outlives every
  // prompt and closes with the service.
  const agents = new Agents({
    nc: connected.nc,
    logger,
    ...(signer ? { identity: { signer } } : {}),
    interceptors: extensions.promptInterceptors,
  });
  activeAgents = agents;
  const toolNames = toolNamesFor(account.agentTools);
  const tools = toolNames
    ? new AgentTools({
        agents,
        tools: toolNames,
        // The agent's own address is left out of discovery and refused, so
        // the model cannot prompt the OpenClaw it runs in.
        selfAddress: AgentSubject.new(AGENT_ID, account.owner, agentName, {
          subjectToken: SUBJECT_AGENT_TOKEN,
        }).prompt,
        extensions: extensions.toolExtensions,
        logger,
      })
    : null;
  activeTools = tools;
  // The extensions' request interceptors first, in load order, then the
  // tools' scope: an extension's interceptor wraps the plugin's, and a
  // request an extension refuses opens no tools scope.
  const interceptors: RequestInterceptor[] = [
    ...extensions.requestInterceptors,
    ...(tools ? [tools.requestInterceptor] : []),
  ];

  const service = new AgentService({
    nc: connected.nc,
    agent: AGENT_ID,
    subjectToken: SUBJECT_AGENT_TOKEN,
    owner: account.owner,
    name: agentName,
    session: DEFAULT_SESSION,
    description: account.description || `OpenClaw agent ${agentName}`,
    version: SERVICE_VERSION,
    attachmentsOk: DEFAULT_ATTACHMENTS_OK,
    heartbeatIntervalS: HEARTBEAT_INTERVAL_S,
    keepaliveIntervalS: ACK_KEEPALIVE_MS / 1_000,
    extraMetadata: {
      platform: "openclaw",
      description: account.description,
    },
    ...(signer ? { identity: { signer } } : {}),
    minSenderTrust: account.minSenderTrust,
    interceptors,
    ...(extensions.heartbeatExtras
      ? { heartbeatExtras: extensions.heartbeatExtras }
      : {}),
    logger,
  });

  const maxPayloadBytes = connected.nc.info?.max_payload ?? 1_048_576;
  service.onPrompt((envelope, response) => {
    const served = servedRequest(envelope, response);
    return turnStore.run(served, () => {
      // The handler's async context is the one every interceptor bound;
      // a tool call that lost it is put back into it through `enter`.
      const turn: Turn = { served, enter: AsyncLocalStorage.snapshot() };
      turnsInFlight.push(turn);
      // Synchronous, in that context, so an extension reads here what its
      // own request interceptor set up.
      extensions.events.promptAccepted(served);
      return serveTurn(turn, extensions, (onDispatchError) =>
        dispatchPromptToOpenClaw(
          ctx,
          account,
          cfg,
          channelRuntime,
          envelope,
          response,
          maxPayloadBytes,
          {
            aroundDispatch: (run) => extensions.events.aroundDispatch(served, run),
            onDispatchError,
          },
        ),
      );
    });
  });

  try {
    await service.start();
  } catch (error) {
    // Not `activeService` yet: the extensions' `stopping()` is owed only
    // to a service that started.
    try {
      await service.stop();
    } catch {}
    await cleanupPrevious();
    throw error;
  }
  activeService = service;

  setActiveConnection(connected.nc, agentName, account.owner);
  // The tools appear to the model once the agent is on the bus.
  const registered = tools
    ? registerAgentTools(tools, {
        activeTurn,
        aroundToolCall: extensions.events.aroundToolCall,
      })
    : [];
  setActiveAgentTools(tools ? registered : null);
  await extensions.started({ agents, service });
  ctx.setStatus({
    ...ctx.getStatus(),
    running: true,
    connected: true,
    statusState: "running",
  });
  ctx.log?.info?.(
    `nats: "${agentName}" registered at ${service.subject.prompt} ` +
      `(instance_id=${service.instanceId}, identity=${service.identity ? "registered" : "off"}, ` +
      `agent_tools=${registered.map((t) => t.name).join(", ") || "none"}, ` +
      `extensions=${extensions.names.join(", ") || "none"})`,
  );

  return new Promise<void>((resolve) => {
    const stop = (): void => {
      cleanupPrevious()
        .then(
          () => ctx.log?.info?.(`nats: "${agentName}" stopped`),
          (err) => ctx.log?.error?.(`nats: shutdown error: ${String(err)}`),
        )
        .finally(resolve);
    };
    if (abortSignal.aborted) stop();
    else abortSignal.addEventListener("abort", stop, { once: true });
  });
}

export async function stopNatsGateway(
  _ctx: ChannelGatewayContext<ResolvedNatsAccount>,
): Promise<void> {
  await cleanupPrevious();
}

/**
 * Serve one prompt: run its dispatch, then settle it for the extensions.
 * The outcome is `ok` when the dispatch resolved and reported no error,
 * `error` when it threw — the handler rejects with that error, and the
 * service answers the caller — or when OpenClaw reported a dispatch error
 * and still resolved.
 */
async function serveTurn(
  turn: Turn,
  extensions: ComposedExtensions,
  dispatch: (onDispatchError: () => void) => Promise<void>,
): Promise<void> {
  let outcome: Outcome = "ok";
  try {
    await dispatch(() => {
      outcome = "error";
    });
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    turnsInFlight = turnsInFlight.filter((t) => t !== turn);
    extensions.events.promptEnded(turn.served, outcome, Date.now());
  }
}

/** What the dispatch of one prompt takes from the extensions and reports back. */
interface DispatchHooks {
  /** The extensions' wrapper around OpenClaw's dispatch of the turn. */
  readonly aroundDispatch: <T>(run: () => Promise<T>) => Promise<T>;
  /** OpenClaw reported a dispatch error and will still resolve. */
  readonly onDispatchError: () => void;
}

async function dispatchPromptToOpenClaw(
  ctx: ChannelGatewayContext<ResolvedNatsAccount>,
  account: ResolvedNatsAccount,
  cfg: Parameters<typeof dispatchInboundDirectDmWithRuntime>[0]["cfg"],
  channelRuntime: ChannelGatewayContext<ResolvedNatsAccount>["channelRuntime"],
  envelope: RequestEnvelope,
  response: PromptResponse,
  maxPayloadBytes: number,
  hooks: DispatchHooks,
): Promise<void> {
  // Sender identity stays structured metadata: it is visible in logs and on
  // PromptResponse, but is never interpolated into the model's prompt text.
  ctx.log?.info?.(
    `nats: incoming prompt sender=${formatSender(response.sender)}`,
  );

  const finalPrompt = stageAttachmentsIntoPrompt({
    baseDir: ATTACHMENT_BASE_DIR,
    agentName: account.agentName,
    prompt: envelope.prompt,
    attachments: (envelope.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      bytes: attachment.content,
    })),
  });

  // Always enable block streaming in OpenClaw so partial text flows.
  if (!channelRuntime) {
    throw new Error("OpenClaw channel runtime is unavailable");
  }
  const directRuntime = channelRuntime as unknown as Parameters<
    typeof dispatchInboundDirectDmWithRuntime
  >[0]["runtime"]["channel"];
  const effectiveRuntime = {
    ...directRuntime,
    reply: {
      ...directRuntime.reply,
      dispatchReplyWithBufferedBlockDispatcher: (
        params: Parameters<
          typeof directRuntime.reply.dispatchReplyWithBufferedBlockDispatcher
        >[0],
      ) => {
        return directRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
          ...params,
          replyOptions: {
            ...params.replyOptions,
            disableBlockStreaming: false,
          },
        });
      },
    },
  };
  // Older OpenClaw releases accepted the narrow `{ channel }` runtime;
  // current releases require the full plugin runtime. The full object is
  // structurally valid for both, with only the reply helper overridden.
  const runtimeWithStreaming = {
    ...getNatsRuntime(),
    channel: effectiveRuntime,
  };

  // The dispatch runs inside the extensions' `aroundDispatch`, so a context
  // an extension binds around it is what OpenClaw's turn runs in.
  await hooks.aroundDispatch(() =>
    dispatchInboundDirectDmWithRuntime({
      cfg,
      runtime: runtimeWithStreaming,
      channel: "nats",
      channelLabel: "NATS",
      accountId: account.accountId,
      peer: { kind: "direct", id: "remote" },
      senderId: "remote",
      senderAddress: "nats:remote",
      recipientAddress: `nats:${account.agentName}`,
      conversationLabel: "remote",
      rawBody: finalPrompt,
      messageId: `nats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      commandAuthorized: true,
      deliver: async (payload) => {
        const text = payload.text ?? "";
        if (!text) return;
        for (const slice of splitResponseText(text, maxPayloadBytes)) {
          await response.send(slice);
        }
      },
      onRecordError: (err) => {
        ctx.log?.error?.(`nats: session record error: ${String(err)}`);
      },
      onDispatchError: (err, info) => {
        ctx.log?.error?.(`nats: ${info.kind} dispatch error: ${String(err)}`);
        // OpenClaw reports some dispatch failures here and still resolves;
        // the turn ended in error either way.
        hooks.onDispatchError();
      },
    }),
  );
}

function gatewayLogger(
  ctx: ChannelGatewayContext<ResolvedNatsAccount>,
): Logger {
  const appendContext = (
    message: string,
    data?: Record<string, unknown>,
  ): string =>
    data === undefined ? message : `${message} ${JSON.stringify(data)}`;
  return {
    debug: (message, data) =>
      ctx.log?.debug?.(`nats: ${appendContext(message, data)}`),
    info: (message, data) =>
      ctx.log?.info?.(`nats: ${appendContext(message, data)}`),
    warn: (message, data) =>
      ctx.log?.warn?.(`nats: ${appendContext(message, data)}`),
    error: (message, data) =>
      ctx.log?.error?.(`nats: ${appendContext(message, data)}`),
  };
}

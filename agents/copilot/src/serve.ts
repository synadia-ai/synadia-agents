/**
 * `serve`: a headless GitHub Copilot fleet agent. Each fleet conversation is
 * a Copilot SDK session (`CopilotClient.createSession` / `resumeSession`),
 * served through the same {@link InboundBridge} the in-session extension
 * uses, so the event → protocol mapping is one piece of code:
 *
 *   prompt                     -> `session.send` (queued per conversation)
 *   assistant.message_delta    -> `response` chunks
 *   tool.execution_*           -> `status`
 *   session.idle               -> terminator
 *   onPermissionRequest        -> §7 query to the prompt's *verified* caller
 *                                 ("yes" approves once); anything else,
 *                                 including no answer, rejects
 *   onUserInputRequest         -> §7 query to the prompt's caller (ask_user)
 *
 * Nothing is approved without an explicit yes; `serve.permissions: "deny"`
 * rejects every request. Conversations are keyed by the envelope's
 * `conversation` / `conversation_id` extra (else one default conversation)
 * and the key → session id map is kept in a state file, so a restarted
 * agent resumes the same Copilot sessions.
 *
 * Independent of `@github/copilot-sdk` (structural types only) so tests
 * drive it with a fake client; `src/cli.ts` adapts the real one.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { NatsConnection } from "@nats-io/transport-node";
import { AgentService, RequestRejectedError, type RequestInterceptor } from "@synadia-ai/agent-service";
import {
  AGENT_TOOL_NAMES,
  AgentSubject,
  AgentTools,
  BLOCKING_AGENT_TOOLS,
  agentToolDefinitions,
  formatSender,
  type AgentToolName,
  type Logger,
} from "@synadia-ai/agents";

import { BridgeClosedError, InboundBridge, QueueFullError, type BridgeSession } from "./bridge.js";
import { AGENT_ID, senderAllowed, serveInstanceName, type ServeSettings, type Settings } from "./config.js";
import {
  EXTENSION_VERSION,
  describePermission,
  framePrompt,
  openNatsConnection,
  parseApproval,
  protocolLogger,
  stageAttachments,
  type Connected,
  type Log,
  type PermissionRequestLike,
  type ServedContext,
} from "./runtime.js";

export const SERVE_HARNESS = "github-copilot-sdk";
export const DEFAULT_CONVERSATION = "default";

/** The `CopilotSession` surface serve uses. */
export interface ServeSession extends BridgeSession {
  readonly sessionId: string;
  disconnect(): Promise<void>;
}

export type ServePermissionResult =
  | { kind: "approve-once" }
  | { kind: "reject"; feedback?: string };

export interface UserInputRequestLike {
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly allowFreeform?: boolean;
}

export interface ServeTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly handler: (args: unknown, invocation: { toolCallId?: string }) => Promise<string>;
}

/** What serve passes to `createSession` / `resumeSession`. */
export interface ServeSessionConfig {
  readonly clientName: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly workingDirectory: string;
  readonly streaming: true;
  readonly tools: ServeTool[];
  readonly onPermissionRequest: (request: PermissionRequestLike) => Promise<ServePermissionResult>;
  readonly onUserInputRequest: (request: UserInputRequestLike) => Promise<{ answer: string; wasFreeform: boolean }>;
}

/** The `CopilotClient` surface serve uses. */
export interface ServeClient {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  createSession(config: ServeSessionConfig): Promise<ServeSession>;
  resumeSession(sessionId: string, config: ServeSessionConfig): Promise<ServeSession>;
}

export interface ServeOptions {
  readonly settings: Settings;
  readonly serve: ServeSettings;
  readonly client: ServeClient;
  readonly log: Log;
  /** For tests: a connection to use instead of resolving one from the settings. */
  readonly nc?: NatsConnection;
  /** For tests. */
  readonly pickupTimeoutMs?: number;
}

interface Conversation {
  readonly key: string;
  session: ServeSession | undefined;
  bridge: InboundBridge | undefined;
  opening: Promise<InboundBridge> | undefined;
  lastUsed: number;
  inFlight: number;
}

/** The conversation a prompt belongs to: the `conversation` / `conversation_id` extra, else the default. */
export function conversationKey(extras: Readonly<Record<string, unknown>> | undefined): string {
  for (const field of ["conversation", "conversation_id", "conversationId"]) {
    const value = extras?.[field];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  return DEFAULT_CONVERSATION;
}

/**
 * The permission policy for a request raised while serving `served`:
 * approve once on an explicit yes from a verified caller, reject otherwise.
 */
export async function decideServePermission(
  request: PermissionRequestLike,
  served: ServedContext | undefined,
  options: { readonly mode: ServeSettings["permissions"]; readonly timeoutMs: number },
): Promise<ServePermissionResult> {
  if (options.mode === "deny") {
    return { kind: "reject", feedback: "this agent denies all permission requests (serve.permissions: deny)" };
  }
  if (request.managedApprovalRequired === true) {
    return { kind: "reject", feedback: "managed policy requires a person to approve this locally" };
  }
  if (!served) return { kind: "reject", feedback: "no remote caller is attached to this turn" };
  if (!served.verified) {
    return {
      kind: "reject",
      feedback: `permission requests are only asked of verified (signed) callers; ${served.sender} is not verified`,
    };
  }
  let reply: string;
  try {
    reply = await served.ask(describePermission(request), options.timeoutMs);
  } catch (error) {
    return { kind: "reject", feedback: `remote caller did not answer: ${errorText(error)}` };
  }
  return parseApproval(reply)
    ? { kind: "approve-once" }
    : { kind: "reject", feedback: `denied by remote caller ${served.sender}` };
}

/** `ask_user`: the question goes to the prompt's caller; with none, the model is told so. */
export async function answerUserInput(
  request: UserInputRequestLike,
  served: ServedContext | undefined,
  timeoutMs: number,
): Promise<{ answer: string; wasFreeform: boolean }> {
  const unavailable = (why: string) => ({
    answer: `The user is not available (${why}). Continue without this answer or end the turn.`,
    wasFreeform: true,
  });
  if (!served) return unavailable("no remote caller is attached to this turn");
  const choices = request.choices ?? [];
  const text = choices.length > 0
    ? `${request.question}\nChoices: ${choices.map((c, i) => `${i + 1}. ${c}`).join("  ")}`
    : request.question;
  try {
    const answer = (await served.ask(text, timeoutMs)).trim();
    const byNumber = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : undefined;
    const picked = byNumber ?? choices.find((c) => c.toLowerCase() === answer.toLowerCase());
    return picked !== undefined ? { answer: picked, wasFreeform: false } : { answer, wasFreeform: true };
  } catch (error) {
    return unavailable(`the caller did not answer: ${errorText(error)}`);
  }
}

export class CopilotServe {
  readonly settings: Settings;
  readonly serve: ServeSettings;
  readonly name: string;
  readonly #client: ServeClient;
  readonly #log: Log;
  readonly #logger: Logger;
  readonly #injectedNc: NatsConnection | undefined;
  readonly #pickupTimeoutMs: number | undefined;
  readonly #conversations = new Map<string, Conversation>();
  #state: Record<string, string> = {};
  #connected: Connected | undefined;
  #service: AgentService | undefined;
  #stagingRoot: string;
  #stopped = false;

  constructor(options: ServeOptions) {
    this.settings = options.settings;
    this.serve = options.serve;
    this.name = serveInstanceName(options.settings);
    this.#client = options.client;
    this.#log = options.log;
    this.#logger = protocolLogger(options.log);
    this.#injectedNc = options.nc;
    this.#pickupTimeoutMs = options.pickupTimeoutMs;
    this.#stagingRoot = join(tmpdir(), "copilot-synadia-nats", `serve-${this.name}-${process.pid}`);
  }

  get promptSubject(): string | undefined {
    return this.#service?.subject.prompt;
  }

  /** Live (open) Copilot sessions. */
  get openSessions(): number {
    return [...this.#conversations.values()].filter((c) => c.session).length;
  }

  get toolNames(): ReadonlyArray<AgentToolName> {
    switch (this.serve.agentTools) {
      case "all":
        return AGENT_TOOL_NAMES;
      case "blocking":
        return BLOCKING_AGENT_TOOLS;
      case "off":
        return [];
    }
  }

  async start(): Promise<void> {
    this.#state = loadState(this.serve.stateFile);
    await this.#client.start();
    let connected: Connected;
    try {
      connected = await openNatsConnection(this.settings, `copilot-serve-${this.name}`, this.#logger, this.#injectedNc);
    } catch (error) {
      await this.#client.stop().catch(() => undefined);
      throw error;
    }
    this.#connected = connected;
    const inbound = this.settings.inbound;
    const allow = inbound.allowSenders;

    const service = new AgentService({
      nc: connected.nc,
      agent: AGENT_ID,
      owner: this.settings.owner,
      name: this.name,
      description: this.settings.description ?? `GitHub Copilot agent ${this.name} (headless, Copilot SDK)`,
      version: EXTENSION_VERSION,
      attachmentsOk: true,
      heartbeatIntervalS: 5,
      keepaliveIntervalS: 30,
      minSenderTrust: inbound.minSenderTrust,
      ...(allow.length > 0
        ? { acceptSender: (sender) => sender?.trust === "verified" && senderAllowed(allow, sender.id) }
        : {}),
      logger: this.#logger,
      interceptors: [this.#admission(), ...this.#toolsInterceptor(connected)],
      heartbeatExtras: () => {
        const conversations = [...this.#conversations.values()];
        return {
          busy: conversations.some((c) => c.inFlight > 0),
          sessions: conversations.filter((c) => c.session).length,
        };
      },
      extraMetadata: {
        harness: SERVE_HARNESS,
        permission_policy: this.serve.permissions,
        ...(this.serve.model ? { model: this.serve.model } : {}),
      },
      ...connected.identity,
    });

    let sequence = 0;
    service.onPrompt(async (envelope, response) => {
      const requestId = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
      const sender = response.sender;
      const senderLabel = formatSender(sender);
      const key = conversationKey(envelope.extras);
      const conversation = this.#conversation(key);
      conversation.inFlight += 1;
      conversation.lastUsed = Date.now();
      try {
        const bridge = await this.#open(conversation);
        const attachments = stageAttachments(this.#stagingRoot, requestId, envelope.attachments);
        const served: ServedContext = {
          sender: senderLabel,
          verified: sender?.trust === "verified",
          ask: async (prompt, timeoutMs) => (await response.ask(prompt, { timeoutMs })).prompt,
          enter: AsyncLocalStorage.snapshot(),
        };
        this.#log(`synadia-nats serve: prompt from ${senderLabel} in conversation ${key} (${envelope.prompt.length} chars)`);
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
      } finally {
        conversation.inFlight -= 1;
        conversation.lastUsed = Date.now();
      }
    });

    try {
      await service.start();
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.#service = service;
    this.#log(
      `synadia-nats serve: listening at ${service.subject.prompt} (min_sender_trust=${inbound.minSenderTrust}` +
        `${allow.length > 0 ? `, ${allow.length} allowed sender(s)` : ""}, permissions=${this.serve.permissions}` +
        `, model=${this.serve.model ?? "default"}, cwd=${this.serve.cwd}` +
        `, fleet tools: ${this.toolNames.join(", ") || "none"})`,
    );
  }

  /** Stop serving, close the sessions (they stay resumable), stop the client, drain NATS. Idempotent. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#service?.stop().catch(() => undefined);
    for (const c of this.#conversations.values()) {
      c.bridge?.close("Copilot agent is shutting down");
      await c.session?.disconnect().catch(() => undefined);
    }
    this.#conversations.clear();
    await this.#client.stop().catch(() => undefined);
    const connected = this.#connected;
    await connected?.tools?.close().catch(() => undefined);
    if (connected && !this.#injectedNc) await connected.nc.drain().catch(() => undefined);
    connected?.bundle?.wipe();
    rmSync(this.#stagingRoot, { recursive: true, force: true });
  }

  #admission(): RequestInterceptor {
    return {
      aroundRequest: (ctx, next) => {
        if (this.#stopped) throw new RequestRejectedError(503, "Copilot agent is shutting down");
        const key = conversationKey(ctx.envelope.extras);
        const existing = this.#conversations.get(key);
        if (existing?.bridge && existing.bridge.queued >= this.settings.inbound.queueLimit) {
          throw new RequestRejectedError(
            503,
            `Copilot conversation ${key} is busy; ${this.settings.inbound.queueLimit} prompt(s) queued`,
          );
        }
        if (!existing?.session && !this.#roomForSession()) {
          throw new RequestRejectedError(503, `Copilot agent is at its limit of ${this.serve.maxSessions} busy session(s)`);
        }
        return next();
      },
    };
  }

  #toolsInterceptor(connected: Connected): RequestInterceptor[] {
    if (this.toolNames.length === 0) return [];
    connected.tools = new AgentTools({
      agents: connected.agents,
      tools: this.toolNames,
      // Discovery leaves this agent out and refuses to prompt it.
      selfAddress: AgentSubject.new(AGENT_ID, this.settings.owner, this.name).prompt,
      logger: this.#logger,
      attachmentRoots: [this.serve.cwd],
    });
    return [connected.tools.requestInterceptor];
  }

  #conversation(key: string): Conversation {
    let c = this.#conversations.get(key);
    if (!c) {
      c = { key, session: undefined, bridge: undefined, opening: undefined, lastUsed: Date.now(), inFlight: 0 };
      this.#conversations.set(key, c);
    }
    return c;
  }

  /** Whether a new session may open, closing the least recently used idle one if needed. */
  #roomForSession(): boolean {
    const open = [...this.#conversations.values()].filter((c) => c.session || c.opening);
    if (open.length < this.serve.maxSessions) return true;
    const idle = open
      .filter((c) => c.session && c.inFlight === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) return false;
    this.#close(idle);
    return true;
  }

  #close(c: Conversation): void {
    c.bridge?.close("Copilot session closed (idle)");
    const session = c.session;
    c.session = undefined;
    c.bridge = undefined;
    this.#conversations.delete(c.key);
    void session?.disconnect().catch(() => undefined);
  }

  #open(c: Conversation): Promise<InboundBridge> {
    if (c.bridge) return Promise.resolve(c.bridge);
    c.opening ??= this.#doOpen(c).finally(() => {
      c.opening = undefined;
    });
    return c.opening;
  }

  async #doOpen(c: Conversation): Promise<InboundBridge> {
    const config = this.#sessionConfig(c);
    const previous = this.#state[c.key];
    let session: ServeSession | undefined;
    if (previous) {
      try {
        session = await this.#client.resumeSession(previous, config);
        this.#log(`synadia-nats serve: resumed session ${session.sessionId} for conversation ${c.key}`);
      } catch (error) {
        this.#log(`synadia-nats serve: cannot resume ${previous} (${errorText(error)}); starting a new session`, "warning");
      }
    }
    if (!session) {
      session = await this.#client.createSession(config);
      this.#log(`synadia-nats serve: new session ${session.sessionId} for conversation ${c.key}`);
    }
    if (this.#stopped) {
      await session.disconnect().catch(() => undefined);
      throw new BridgeClosedError("Copilot agent is shutting down");
    }
    if (this.#state[c.key] !== session.sessionId) {
      this.#state[c.key] = session.sessionId;
      saveState(this.serve.stateFile, this.#state, (m) => this.#log(m, "warning"));
    }
    c.session = session;
    c.bridge = new InboundBridge(session, {
      queueLimit: this.settings.inbound.queueLimit,
      ...(this.#pickupTimeoutMs !== undefined ? { pickupTimeoutMs: this.#pickupTimeoutMs } : {}),
      log: (m) => this.#log(m, "warning"),
    });
    return c.bridge;
  }

  #sessionConfig(c: Conversation): ServeSessionConfig {
    const served = () => c.bridge?.current()?.context as ServedContext | undefined;
    const timeoutMs = this.settings.inbound.permissionTimeoutMs;
    return {
      clientName: "synadia-nats-serve",
      ...(this.serve.model ? { model: this.serve.model } : {}),
      ...(this.serve.reasoningEffort ? { reasoningEffort: this.serve.reasoningEffort } : {}),
      workingDirectory: this.serve.cwd,
      streaming: true,
      tools: this.#fleetTools(served),
      onPermissionRequest: (request) =>
        decideServePermission(request, served(), { mode: this.serve.permissions, timeoutMs }).then((decision) => {
          this.#log(
            `synadia-nats serve: permission ${String(request.kind ?? "unknown")} -> ${decision.kind}` +
              `${decision.kind === "reject" && decision.feedback ? ` (${decision.feedback})` : ""}`,
          );
          return decision;
        }),
      onUserInputRequest: (request) => answerUserInput(request, served(), timeoutMs),
    };
  }

  /**
   * The fleet tools as SDK tools. They do not skip permission: each call
   * raises a `custom-tool` request that the policy above decides.
   */
  #fleetTools(served: () => ServedContext | undefined): ServeTool[] {
    const offered = new Set<string>(this.toolNames);
    return agentToolDefinitions()
      .filter((d) => offered.has(d.name))
      .map((d) => ({
        name: `${this.settings.toolPrefix}${d.name}`,
        description: `${d.description}\n\n(Synadia Agent Protocol for NATS fleet.)`,
        parameters: d.parameters as Record<string, unknown>,
        handler: async (args, invocation) => {
          const tools = this.#connected?.tools;
          if (!tools) return JSON.stringify({ error: "agent tools are off" });
          const run = () =>
            tools.execute(d.name, args ?? {}, invocation.toolCallId ? { toolCallId: invocation.toolCallId } : {});
          const context = served();
          return JSON.stringify(await (context ? context.enter(run) : run()));
        },
      }));
  }
}

export function loadState(path: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const conversations = (parsed as { conversations?: unknown })?.conversations;
    if (typeof conversations !== "object" || conversations === null) return {};
    return Object.fromEntries(
      Object.entries(conversations).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function saveState(path: string, conversations: Record<string, string>, warn: (m: string) => void): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, conversations }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    warn(`synadia-nats serve: cannot save state to ${path}: ${errorText(error)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

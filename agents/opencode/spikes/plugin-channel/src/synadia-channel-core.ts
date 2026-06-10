import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { connect as natsConnect } from "@nats-io/transport-node";
import { AgentService, type PromptResponse } from "@synadia-ai/agent-service";

export type PermissionReply = "once" | "always" | "reject";

export interface SynadiaChannelOptions {
  natsUrl?: string;
  owner?: string;
  session?: string;
  logPath?: string;
  heartbeatIntervalS?: number;
  keepaliveIntervalS?: number | null;
}

export interface SynadiaPluginContext {
  client: {
    permission?: {
      reply?: (input: { requestID: string; reply: PermissionReply; message?: string }) => Promise<unknown> | unknown;
    };
    app?: {
      log?: (input: { body: Record<string, unknown> }) => Promise<unknown> | unknown;
    };
  };
  project?: Record<string, unknown>;
  directory?: string;
  worktree?: string;
  serverUrl?: URL;
}

interface ActivePrompt {
  sessionID: string;
  response: PromptResponseLike;
}

export interface PromptResponseLike {
  send(chunk: string | { type: string; text?: string; status?: string; data?: unknown }): Promise<void> | void;
  ask(prompt: string, opts: { timeoutMs: number; attachments?: readonly unknown[] }): Promise<{ prompt?: string }>;
}

export interface SynadiaChannelState {
  subject?: string;
  eventTypes: Map<string, number>;
  activePrompts: Map<string, ActivePrompt>;
  disposeCount: number;
}

export function safeToken(input: string, fallback: string): string {
  const normalized = input.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return normalized || fallback;
}

export function shortHash(input: unknown): string {
  return createHash("sha256").update(String(input ?? "")).digest("hex").slice(0, 12);
}

export function deriveIdentity(ctx: SynadiaPluginContext, options: SynadiaChannelOptions = {}): { owner: string; session: string; metadata: Record<string, string> } {
  const owner = safeToken(options.owner ?? process.env.SYNADIA_OWNER ?? "opencode", "opencode");
  const explicitSession = options.session ?? process.env.SYNADIA_SESSION;
  const directoryHash = shortHash(ctx.directory ?? "");
  const worktreeHash = shortHash(ctx.worktree ?? "");
  const projectIdHash = shortHash(typeof ctx.project?.id === "string" ? ctx.project.id : "");
  const session = safeToken(explicitSession ?? `session-${directoryHash}`, `session-${directoryHash}`);
  return {
    owner,
    session,
    metadata: {
      opencode_plugin: "true",
      opencode_identity_source: explicitSession ? "explicit" : "hashed-directory",
      opencode_directory_hash: directoryHash,
      opencode_worktree_hash: worktreeHash,
      opencode_project_id_hash: projectIdHash,
      opencode_server_origin: safeOrigin(ctx.serverUrl),
    },
  };
}

export function summarizeEvent(event: unknown): { type: string; keys: string[]; sessionID?: string; permissionID?: string } {
  const record = isRecord(event) ? event : {};
  const type = typeof record.type === "string" ? record.type : "unknown";
  const props = isRecord(record.properties) ? record.properties : record;
  const sessionID = readString(props, "sessionID") ?? readString(props, "sessionId") ?? readString(props, "session_id");
  const permissionID = readString(props, "id") ?? readString(props, "requestID") ?? readString(props, "permissionID");
  return { type, keys: Object.keys(props).sort(), ...(sessionID ? { sessionID } : {}), ...(permissionID ? { permissionID } : {}) };
}

export async function handlePermissionAsked(input: {
  event: unknown;
  state: SynadiaChannelState;
  client: SynadiaPluginContext["client"];
  log: (message: string, extra?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const summary = summarizeEvent(input.event);
  if (summary.type !== "permission.asked") return false;
  if (!summary.permissionID) {
    input.log("permission event missing request id", { keys: summary.keys });
    return false;
  }
  const sessionID = summary.sessionID ?? "default";
  const active = input.state.activePrompts.get(sessionID) ?? input.state.activePrompts.get("default");
  if (!active) {
    input.log("permission event observed without active protocol prompt", { sessionID, requestID: summary.permissionID });
    return false;
  }
  const answer = await active.response.ask(formatPermissionQuestion(input.event), { timeoutMs: 30_000, attachments: [] });
  const reply = mapPermissionReply(answer.prompt);
  await input.client.permission?.reply?.({ requestID: summary.permissionID, ...reply });
  input.log("permission event bridged", { sessionID, requestID: summary.permissionID, reply: reply.reply });
  return true;
}

export async function createSynadiaChannel(ctx: SynadiaPluginContext, options: SynadiaChannelOptions = {}) {
  const state: SynadiaChannelState = { eventTypes: new Map(), activePrompts: new Map(), disposeCount: 0 };
  const log = makeLogger(options.logPath ?? process.env.SYNADIA_PLUGIN_LOG, ctx);
  const natsUrl = options.natsUrl ?? process.env.SYNADIA_NATS_URL;
  const identity = deriveIdentity(ctx, options);
  let nc: Awaited<ReturnType<typeof natsConnect>> | undefined;
  let service: AgentService | undefined;

  log("plugin initializing", { owner: identity.owner, session: identity.session, metadata: identity.metadata });

  if (natsUrl) {
    nc = await natsConnect({ servers: natsUrl });
    service = new AgentService({
      nc,
      agent: "opencode",
      subjectToken: "opencode",
      owner: identity.owner,
      name: identity.session,
      session: identity.session,
      version: "0.0.0-spike",
      description: "OpenCode in-process Synadia channel spike",
      attachmentsOk: false,
      heartbeatIntervalS: options.heartbeatIntervalS ?? 2,
      keepaliveIntervalS: options.keepaliveIntervalS ?? null,
      extraMetadata: identity.metadata,
    });
    service.onPrompt(async (envelope, response) => {
      const sessionID = readString(envelope as unknown as Record<string, unknown>, "opencode_session_id") ?? "default";
      const promptResponse = response as unknown as PromptResponseLike;
      state.activePrompts.set(sessionID, { sessionID, response: promptResponse });
      try {
        await response.send({ type: "status", status: "opencode plugin channel received prompt" });
        await response.send(`plugin echo: ${envelope.prompt}`);
      } finally {
        state.activePrompts.delete(sessionID);
      }
    });
    await service.start();
    state.subject = service.subject.prompt;
    log("nats service registered", { subject: state.subject, owner: identity.owner, session: identity.session });
  } else {
    log("nats disabled: SYNADIA_NATS_URL not set", { owner: identity.owner, session: identity.session });
  }

  return {
    state,
    hooks: {
      event: async ({ event }: { event: unknown }) => {
        const summary = summarizeEvent(event);
        state.eventTypes.set(summary.type, (state.eventTypes.get(summary.type) ?? 0) + 1);
        log("event observed", { ...summary, count: state.eventTypes.get(summary.type) });
        await handlePermissionAsked({ event, state, client: ctx.client, log });
      },
      dispose: async () => {
        state.disposeCount += 1;
        log("dispose starting", { disposeCount: state.disposeCount, subject: state.subject });
        await service?.stop();
        await nc?.drain();
        log("dispose complete", { disposeCount: state.disposeCount });
      },
    },
  };
}

export function formatPermissionQuestion(event: unknown): string {
  const summary = summarizeEvent(event);
  const props = isRecord(event) && isRecord(event.properties) ? event.properties : {};
  const permission = readString(props, "permission") ?? "unknown";
  const patterns = Array.isArray(props.patterns) ? props.patterns.join(", ") : "";
  return `OpenCode requests permission ${permission}${patterns ? ` for ${patterns}` : ""}. Reply yes/once, always, or no.`;
}

export function mapPermissionReply(input: string | undefined): { reply: PermissionReply; message?: string } {
  const normalized = (input ?? "").trim().toLowerCase();
  if (["always", "allow always", "yes always"].includes(normalized)) return { reply: "always" };
  if (["yes", "y", "once", "allow", "true"].includes(normalized)) return { reply: "once" };
  if (["no", "n", "deny", "reject", "false"].includes(normalized)) return { reply: "reject", message: "Rejected by protocol query reply" };
  return { reply: "reject", message: normalized ? "Rejected by ambiguous protocol query reply" : "Rejected by empty protocol query reply" };
}

function makeLogger(logPath: string | undefined, ctx: SynadiaPluginContext) {
  return (message: string, extra: Record<string, unknown> = {}) => {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      message,
      directory_hash: shortHash(ctx.directory ?? ""),
      worktree_hash: shortHash(ctx.worktree ?? ""),
      ...extra,
    });
    if (logPath) {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${entry}\n`);
    }
    void ctx.client.app?.log?.({ body: { service: "synadia-channel-spike", level: "info", message, extra } });
  };
}

function safeOrigin(url: unknown): string {
  try {
    return url instanceof URL ? url.origin : "";
  } catch {
    return "";
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

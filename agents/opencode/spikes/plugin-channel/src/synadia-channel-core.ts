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
    postSessionIdPermissionsPermissionId?: (input: { path: { id: string; permissionID: string }; query?: { directory?: string }; body: { response: PermissionReply } }) => Promise<unknown> | unknown;
    permission?: {
      reply?: (input: { requestID: string; reply: PermissionReply; message?: string; directory?: string }) => Promise<unknown> | unknown;
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
  duplicateInitCount: number;
  permissionBridgeCount: number;
}

interface ChannelInstance {
  state: SynadiaChannelState;
  hooks: {
    event: (input: { event: unknown }) => Promise<void>;
    dispose: () => Promise<void>;
  };
}

const activeChannels = new Map<string, ChannelInstance>();

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
  const permissionID = readString(props, "id") ?? readString(props, "requestID") ?? readString(props, "permissionID") ?? readString(props, "permissionId");
  return { type, keys: Object.keys(props).sort(), ...(sessionID ? { sessionID } : {}), ...(permissionID ? { permissionID } : {}) };
}

function isPermissionRequestEvent(type: string): boolean {
  return type === "permission.asked" || type === "permission.v2.asked" || type === "permission.updated";
}

export async function handlePermissionAsked(input: {
  event: unknown;
  state: SynadiaChannelState;
  client: SynadiaPluginContext["client"];
  directory?: string;
  serverUrl?: URL;
  log: (message: string, extra?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const summary = summarizeEvent(input.event);
  if (!isPermissionRequestEvent(summary.type)) return false;
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
  await replyToOpenCodePermission(input.client, sessionID, summary.permissionID, reply.reply, input.directory, input.serverUrl);
  input.state.permissionBridgeCount += 1;
  input.log("permission event bridged", { sessionID, requestID: summary.permissionID, reply: reply.reply, permissionBridgeCount: input.state.permissionBridgeCount });
  return true;
}

export async function createSynadiaChannel(ctx: SynadiaPluginContext, options: SynadiaChannelOptions = {}) {
  const log = makeLogger(options.logPath ?? process.env.SYNADIA_PLUGIN_LOG, ctx);
  const natsUrl = options.natsUrl ?? process.env.SYNADIA_NATS_URL;
  const identity = deriveIdentity(ctx, options);
  const channelKey = `${natsUrl ?? "disabled"}:${identity.owner}:${identity.session}`;
  const existing = activeChannels.get(channelKey);
  if (existing) {
    existing.state.duplicateInitCount += 1;
    log("duplicate initialization reused existing channel", { owner: identity.owner, session: identity.session, subject: existing.state.subject, duplicateInitCount: existing.state.duplicateInitCount });
    return {
      state: existing.state,
      hooks: {
        event: async () => undefined,
        dispose: async () => log("duplicate dispose ignored", { owner: identity.owner, session: identity.session, subject: existing.state.subject }),
      },
    };
  }

  const state: SynadiaChannelState = { eventTypes: new Map(), activePrompts: new Map(), disposeCount: 0, duplicateInitCount: 0, permissionBridgeCount: 0 };
  let nc: Awaited<ReturnType<typeof natsConnect>> | undefined;
  let service: AgentService | undefined;
  let disposed = false;

  log("plugin initializing", { owner: identity.owner, session: identity.session, metadata: identity.metadata, clientKeys: Object.keys(ctx.client).sort(), hasPermissionNamespace: Boolean(ctx.client.permission) });

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
        if (String(envelope.prompt ?? "").includes("hold_for_permission_probe")) {
          const beforeBridgeCount = state.permissionBridgeCount;
          log("permission probe prompt active", { sessionID, beforeBridgeCount });
          await waitFor(() => state.permissionBridgeCount > beforeBridgeCount, 30_000, "permission bridge");
          await response.send(`plugin permission bridge complete: ${envelope.prompt}`);
        } else {
          await response.send(`plugin echo: ${envelope.prompt}`);
        }
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

  const instance: ChannelInstance = {
    state,
    hooks: {
      event: async ({ event }: { event: unknown }) => {
        const summary = summarizeEvent(event);
        state.eventTypes.set(summary.type, (state.eventTypes.get(summary.type) ?? 0) + 1);
        log("event observed", { ...summary, count: state.eventTypes.get(summary.type) });
        await handlePermissionAsked({ event, state, client: ctx.client, directory: ctx.directory, serverUrl: ctx.serverUrl, log });
      },
      dispose: async () => {
        if (disposed) {
          log("dispose skipped: already disposed", { disposeCount: state.disposeCount, subject: state.subject });
          return;
        }
        disposed = true;
        state.disposeCount += 1;
        log("dispose starting", { disposeCount: state.disposeCount, subject: state.subject });
        activeChannels.delete(channelKey);
        await service?.stop();
        await nc?.drain();
        log("dispose complete", { disposeCount: state.disposeCount });
      },
    },
  };
  activeChannels.set(channelKey, instance);
  return instance;
}

export function formatPermissionQuestion(event: unknown): string {
  const props = isRecord(event) && isRecord(event.properties) ? event.properties : {};
  const permission = readString(props, "permission") ?? readString(props, "action") ?? readString(props, "type") ?? "unknown";
  const title = readString(props, "title");
  const pattern = readString(props, "pattern");
  const resources = Array.isArray(props.resources) ? props.resources.join(", ") : undefined;
  const patterns = Array.isArray(props.patterns) ? props.patterns.join(", ") : pattern ?? resources ?? "";
  return `OpenCode requests permission ${permission}${title ? ` (${title})` : ""}${patterns ? ` for ${patterns}` : ""}. Reply yes/once, always, or no.`;
}

export function mapPermissionReply(input: string | undefined): { reply: PermissionReply; message?: string } {
  const normalized = (input ?? "").trim().toLowerCase();
  if (["always", "allow always", "yes always"].includes(normalized)) return { reply: "always" };
  if (["yes", "y", "once", "allow", "true"].includes(normalized)) return { reply: "once" };
  if (["no", "n", "deny", "reject", "false"].includes(normalized)) return { reply: "reject", message: "Rejected by protocol query reply" };
  return { reply: "reject", message: normalized ? "Rejected by ambiguous protocol query reply" : "Rejected by empty protocol query reply" };
}

async function replyToOpenCodePermission(client: SynadiaPluginContext["client"], sessionID: string, permissionID: string, reply: PermissionReply, directory?: string, serverUrl?: URL): Promise<void> {
  let sdkError: unknown;
  if (client.permission?.reply) {
    const result = await client.permission.reply({ requestID: permissionID, reply, ...(directory ? { directory } : {}) });
    if (!isRecord(result) || !result.error) return;
    sdkError = result.error;
  }
  if (serverUrl) {
    const direct = await postPermissionReply(serverUrl, `/permission/${encodeURIComponent(permissionID)}/reply`, { requestID: permissionID, reply, directory });
    if (direct.ok) return;
    const scoped = await postPermissionReply(serverUrl, `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(permissionID)}/reply`, { requestID: permissionID, reply });
    if (scoped.ok) return;
    if (!client.postSessionIdPermissionsPermissionId) {
      const prefix = sdkError ? `SDK reply failed first: ${JSON.stringify(sdkError)}; ` : "";
      throw new Error(`${prefix}OpenCode permission direct reply failed: ${direct.status} ${direct.text}; scoped: ${scoped.status} ${scoped.text}`);
    }
  }
  if (client.postSessionIdPermissionsPermissionId) {
    const result = await client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID },
      ...(directory ? { query: { directory } } : {}),
      body: { response: reply },
    });
    if (isRecord(result) && result.error) throw new Error(`OpenCode permission reply failed: ${JSON.stringify(result.error)}`);
    return;
  }
  if (sdkError) throw new Error(`OpenCode permission reply failed: ${JSON.stringify(sdkError)}`);
}

async function postPermissionReply(serverUrl: URL, path: string, input: { requestID: string; reply: PermissionReply; directory?: string }): Promise<{ ok: boolean; status: number; text: string }> {
  const url = new URL(path, serverUrl);
  if (input.directory) url.searchParams.set("directory", input.directory);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply: input.reply, response: input.reply }),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, text };
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

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

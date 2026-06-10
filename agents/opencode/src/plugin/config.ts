import type { NatsConfig, OpenCodeChannelConfig, PermissionPolicy } from "../types.js";
import { derivePluginIdentity } from "./identity.js";
import type { OpenCodePluginContext, PluginIdentity } from "./types.js";

export interface ResolvedPluginConfig {
  readonly config: OpenCodeChannelConfig;
  readonly identity: PluginIdentity;
}

export function resolvePluginConfig(
  ctx: OpenCodePluginContext,
  env: Record<string, string | undefined> = process.env,
): ResolvedPluginConfig {
  const identity = derivePluginIdentity(ctx, env);
  const natsContext = pick(env.NATS_CONTEXT, env.SYNADIA_NATS_CONTEXT);
  const natsCreds = pick(env.NATS_CREDS, env.NATS_CREDENTIALS, env.SYNADIA_NATS_CREDS);
  const natsUrl = pick(env.NATS_URL, env.SYNADIA_NATS_URL, "nats://127.0.0.1:4222") ?? "nats://127.0.0.1:4222";
  const serverUrl = serverUrlString(ctx.serverUrl);
  const nats: NatsConfig = {
    url: natsUrl,
    ...(natsContext ? { context: natsContext } : {}),
    ...(natsCreds ? { creds: natsCreds } : {}),
  };
  const permissionPolicy = parsePermissionPolicy(pick(env.OPENCODE_PERMISSION_POLICY, env.SYNADIA_OPENCODE_PERMISSION_POLICY, "query")!, "OPENCODE_PERMISSION_POLICY");
  const config: OpenCodeChannelConfig = {
    nats,
    agent: {
      owner: identity.owner,
      name: identity.session,
      subjectToken: "opencode",
      heartbeatIntervalS: parsePositiveNumber(pick(env.SYNADIA_OPENCODE_HEARTBEAT_INTERVAL_S, "30")!, "SYNADIA_OPENCODE_HEARTBEAT_INTERVAL_S"),
      keepaliveIntervalS: parsePositiveNumber(pick(env.SYNADIA_OPENCODE_KEEPALIVE_INTERVAL_S, "30")!, "SYNADIA_OPENCODE_KEEPALIVE_INTERVAL_S"),
    },
    opencode: {
      mode: "plugin",
      hostname: "127.0.0.1",
      port: parsePositiveNumber(pick(env.OPENCODE_PORT, "4096")!, "OPENCODE_PORT"),
      ...(ctx.directory ? { directory: ctx.directory } : {}),
      ...(ctx.worktree ? { workspace: ctx.worktree } : {}),
      ...(serverUrl ? { baseUrl: serverUrl } : {}),
      ...(pick(env.OPENCODE_SESSION_ID) ? { sessionId: pick(env.OPENCODE_SESSION_ID)! } : {}),
      ...(pick(env.OPENCODE_MODEL) ? { model: pick(env.OPENCODE_MODEL)! } : {}),
      ...(pick(env.OPENCODE_AGENT) ? { agent: pick(env.OPENCODE_AGENT)! } : {}),
      permissionPolicy,
      permissionTimeoutMs: parsePositiveNumber(pick(env.OPENCODE_PERMISSION_TIMEOUT_MS, "300000")!, "OPENCODE_PERMISSION_TIMEOUT_MS"),
    },
  };
  return { config, identity };
}

function pick(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value !== "");
}

function parsePositiveNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} must be a positive number`);
  return parsed;
}

function parsePermissionPolicy(value: string, field: string): PermissionPolicy {
  if (value === "query" || value === "local" || value === "reject") return value;
  throw new Error(`${field} must be query, local, or reject`);
}

function serverUrlString(value: unknown): string | undefined {
  if (value instanceof URL) return value.toString();
  return typeof value === "string" && value ? value : undefined;
}

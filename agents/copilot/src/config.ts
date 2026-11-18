/**
 * Configuration for the Copilot NATS extension: a JSON file plus environment
 * variables, environment winning. Nothing here reads a NATS context or a
 * credentials file; it only decides what to connect to and how to behave.
 *
 * Security defaults (see README "Security"):
 *   - inbound (the session answering fleet prompts) is OFF unless
 *     `inbound.enabled: true` or `SYNADIA_COPILOT_INBOUND=1`;
 *   - permission prompts raised while serving a remote prompt stay with the
 *     local UI (`permissions: "ui"`); `"query"` forwards them to the caller
 *     as a §7 query, and nothing is ever auto-approved;
 *   - with no server configured the extension connects to a local
 *     `nats://127.0.0.1:4222`, not the public demo server: it loads into
 *     every Copilot session, so it must not reach the internet by default.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { NatsConnectionSource } from "@synadia-ai/agents";

export type SenderIdentityMode = "off" | "signed";
export type MinSenderTrust = "any" | "signed";
export type AgentToolsMode = "blocking" | "all" | "off";
export type PermissionMode = "ui" | "query";

export const DEFAULT_NATS_URL = "nats://127.0.0.1:4222";
export const AGENT_ID = "copilot";
export const DEFAULT_QUEUE_LIMIT = 8;
export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

export interface FileConfig {
  readonly context?: string;
  readonly url?: string;
  readonly creds?: string;
  readonly owner?: string;
  readonly name?: string;
  readonly description?: string;
  readonly senderIdentity?: SenderIdentityMode;
  readonly agentTools?: AgentToolsMode;
  readonly toolPrefix?: string;
  readonly inbound?: {
    readonly enabled?: boolean;
    readonly minSenderTrust?: MinSenderTrust;
    readonly allowSenders?: ReadonlyArray<string>;
    readonly permissions?: PermissionMode;
    readonly permissionTimeoutMs?: number;
    readonly queueLimit?: number;
  };
  /** The headless `serve` agent (ignored by the in-session extension). */
  readonly serve?: {
    readonly model?: string;
    readonly reasoningEffort?: ReasoningEffort;
    readonly cwd?: string;
    readonly permissions?: ServePermissionMode;
    readonly agentTools?: AgentToolsMode;
    readonly maxSessions?: number;
    readonly stateFile?: string;
  };
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** `query`: ask the prompt's verified caller (§7); `deny`: reject every permission request. */
export type ServePermissionMode = "query" | "deny";
export const DEFAULT_MAX_SESSIONS = 8;

export interface ServeSettings {
  readonly model: string | undefined;
  readonly reasoningEffort: ReasoningEffort | undefined;
  readonly cwd: string;
  readonly permissions: ServePermissionMode;
  readonly agentTools: AgentToolsMode;
  readonly maxSessions: number;
  readonly stateFile: string;
}

export interface Settings {
  readonly disabled: boolean;
  readonly connectionSource: NatsConnectionSource;
  readonly connectionLabel: string;
  readonly owner: string;
  /** Instance name override; `undefined` derives one from the session id. */
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly senderIdentity: SenderIdentityMode;
  readonly agentTools: AgentToolsMode;
  readonly toolPrefix: string;
  readonly inbound: {
    readonly enabled: boolean;
    readonly minSenderTrust: MinSenderTrust;
    readonly allowSenders: ReadonlyArray<string>;
    readonly permissions: PermissionMode;
    readonly permissionTimeoutMs: number;
    readonly queueLimit: number;
  };
  /** Where the file config came from, for log lines. */
  readonly configFile: string | undefined;
}

/**
 * The config file to read: `SYNADIA_COPILOT_CONFIG`, else `config.json` next
 * to the installed extension, else `~/.copilot/synadia-nats/config.json`.
 * Returns `undefined` when none exists.
 */
export function findConfigFile(env: NodeJS.ProcessEnv, extensionDir: string | undefined): string | undefined {
  if (env.SYNADIA_COPILOT_CONFIG) return env.SYNADIA_COPILOT_CONFIG;
  const candidates = [
    ...(extensionDir ? [join(extensionDir, "config.json")] : []),
    join(env.COPILOT_HOME || join(homedir(), ".copilot"), "synadia-nats", "config.json"),
  ];
  return candidates.find((p) => existsSync(p));
}

export function loadConfigFile(path: string | undefined): FileConfig {
  if (path === undefined) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw new Error(`invalid ${path}: cannot read file`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`invalid ${path}: expected valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`invalid ${path}: expected an object`);
  for (const key of ["context", "url", "creds", "owner", "name", "description", "toolPrefix"]) {
    optionalString(parsed, key);
  }
  if (parsed.inbound !== undefined) {
    if (!isRecord(parsed.inbound)) throw new Error("invalid inbound: expected an object");
    const inbound = parsed.inbound;
    if (inbound.enabled !== undefined && typeof inbound.enabled !== "boolean") {
      throw new Error("invalid inbound.enabled: expected true or false");
    }
    if (
      inbound.allowSenders !== undefined &&
      (!Array.isArray(inbound.allowSenders) || !inbound.allowSenders.every((s) => typeof s === "string" && s))
    ) {
      throw new Error("invalid inbound.allowSenders: expected an array of sender ids");
    }
  }
  if (parsed.serve !== undefined) {
    if (!isRecord(parsed.serve)) throw new Error("invalid serve: expected an object");
    for (const key of ["model", "reasoningEffort", "cwd", "permissions", "agentTools", "stateFile"]) {
      optionalString(parsed.serve, key);
    }
  }
  return parsed as FileConfig;
}

export function resolveSettings(
  config: FileConfig,
  env: NodeJS.ProcessEnv,
  configFile?: string,
): Settings {
  const disabled = parseBool("SYNADIA_COPILOT_DISABLE", env.SYNADIA_COPILOT_DISABLE) ?? false;

  const url = env.NATS_URL || undefined;
  const creds = env.NATS_CREDS || env.NATS_CREDENTIALS || undefined;
  const directEnv = url !== undefined || creds !== undefined;
  const contextFromEnv = env.NATS_CONTEXT !== undefined;
  const context = contextFromEnv
    ? env.NATS_CONTEXT || undefined
    : directEnv
      ? undefined
      : config.context || undefined;
  const finalUrl = context ? undefined : (url ?? (directEnv ? undefined : config.url));
  const finalCreds = context ? undefined : (creds ?? (directEnv ? undefined : config.creds));
  if (!context && finalCreds && !finalUrl) {
    throw new Error("invalid NATS_CREDS: credentials set without a server URL; set NATS_URL too");
  }
  const connectionSource: NatsConnectionSource = context
    ? { context }
    : finalCreds
      ? { url: finalUrl as string, creds: finalCreds }
      : { url: finalUrl ?? DEFAULT_NATS_URL };
  const connectionLabel = context
    ? `context ${context}`
    : finalUrl
      ? redactUrl(finalUrl)
      : `default ${DEFAULT_NATS_URL}`;

  const owner = sanitizeToken(
    env.SYNADIA_COPILOT_OWNER || env.SYNADIA_OWNER || config.owner || env.USER || env.USERNAME || "copilot",
  );
  const nameRaw = env.SYNADIA_COPILOT_NAME || config.name || undefined;
  const name = nameRaw ? sanitizeToken(nameRaw) : undefined;
  const description = env.SYNADIA_COPILOT_DESCRIPTION || config.description || undefined;

  const senderIdentity = enumSetting(
    "senderIdentity",
    env.NATS_SENDER_IDENTITY || config.senderIdentity || "off",
    ["off", "signed"] as const,
  );
  const agentTools = enumSetting(
    "agentTools",
    env.NATS_AGENT_TOOLS || config.agentTools || "blocking",
    ["blocking", "all", "off"] as const,
  );
  const toolPrefix = env.SYNADIA_COPILOT_TOOL_PREFIX ?? config.toolPrefix ?? "";
  if (toolPrefix !== "" && !/^[A-Za-z][A-Za-z0-9_]*$/.test(toolPrefix)) {
    throw new Error("invalid toolPrefix: letters, digits and underscores, starting with a letter");
  }

  const inboundCfg = config.inbound ?? {};
  const enabled =
    parseBool("SYNADIA_COPILOT_INBOUND", env.SYNADIA_COPILOT_INBOUND) ?? inboundCfg.enabled ?? false;
  const allowSenders = env.SYNADIA_COPILOT_ALLOW_SENDERS
    ? env.SYNADIA_COPILOT_ALLOW_SENDERS.split(",").map((s) => s.trim()).filter(Boolean)
    : [...(inboundCfg.allowSenders ?? [])];
  // An allowlist names verified ids, so it implies signed prompts.
  const minSenderTrust = allowSenders.length > 0
    ? "signed"
    : enumSetting(
        "inbound.minSenderTrust",
        env.NATS_MIN_SENDER_TRUST || inboundCfg.minSenderTrust || "any",
        ["any", "signed"] as const,
      );
  const permissions = enumSetting(
    "inbound.permissions",
    env.SYNADIA_COPILOT_PERMISSIONS || inboundCfg.permissions || "ui",
    ["ui", "query"] as const,
  );
  const permissionTimeoutMs = positiveInt(
    "inbound.permissionTimeoutMs",
    env.SYNADIA_COPILOT_PERMISSION_TIMEOUT_MS ?? inboundCfg.permissionTimeoutMs,
    DEFAULT_PERMISSION_TIMEOUT_MS,
  );
  const queueLimit = positiveInt(
    "inbound.queueLimit",
    env.SYNADIA_COPILOT_QUEUE_LIMIT ?? inboundCfg.queueLimit,
    DEFAULT_QUEUE_LIMIT,
  );

  return {
    disabled,
    connectionSource,
    connectionLabel,
    owner,
    name,
    description,
    senderIdentity,
    agentTools,
    toolPrefix,
    inbound: { enabled, minSenderTrust, allowSenders, permissions, permissionTimeoutMs, queueLimit },
    configFile,
  };
}

/**
 * Settings for the headless `serve` agent. It always serves (that is its
 * job), so `inbound.enabled` does not apply; the inbound sender policy
 * (`minSenderTrust`, `allowSenders`, `permissionTimeoutMs`, `queueLimit`)
 * does. Defaults: permissions are asked of the verified caller, the fleet
 * tools are off, the working directory is the process's.
 */
export function resolveServeSettings(
  config: FileConfig,
  env: NodeJS.ProcessEnv,
  settings: Pick<Settings, "owner" | "name">,
  cwd: string = process.cwd(),
): ServeSettings {
  const serve = config.serve ?? {};
  const model = env.SYNADIA_COPILOT_MODEL || serve.model || undefined;
  const effortRaw = env.SYNADIA_COPILOT_REASONING_EFFORT || serve.reasoningEffort || undefined;
  const reasoningEffort = effortRaw
    ? enumSetting("serve.reasoningEffort", effortRaw, ["low", "medium", "high", "xhigh", "max"] as const)
    : undefined;
  const permissions = enumSetting(
    "serve.permissions",
    env.SYNADIA_COPILOT_SERVE_PERMISSIONS || serve.permissions || "query",
    ["query", "deny"] as const,
  );
  const agentTools = enumSetting(
    "serve.agentTools",
    env.SYNADIA_COPILOT_SERVE_AGENT_TOOLS || serve.agentTools || "off",
    ["blocking", "all", "off"] as const,
  );
  const maxSessions = positiveInt(
    "serve.maxSessions",
    env.SYNADIA_COPILOT_MAX_SESSIONS ?? serve.maxSessions,
    DEFAULT_MAX_SESSIONS,
  );
  const name = serveInstanceName(settings);
  const stateFile =
    env.SYNADIA_COPILOT_STATE_FILE ||
    serve.stateFile ||
    join(env.COPILOT_HOME || join(homedir(), ".copilot"), "synadia-nats", `serve-${settings.owner}-${name}.json`);
  return {
    model,
    reasoningEffort,
    cwd: env.SYNADIA_COPILOT_CWD || serve.cwd || cwd,
    permissions,
    agentTools,
    maxSessions,
    stateFile,
  };
}

/** The `serve` instance name: the override, else `serve-<host>`. */
export function serveInstanceName(settings: Pick<Settings, "name">, host: string = hostname()): string {
  return settings.name ?? sanitizeToken(`serve-${host}`);
}

/** A NATS subject token: lowercase letters, digits, `-` and `_`. */
export function sanitizeToken(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "copilot";
}

/** The instance name for a session: the override, else `copilot-<first 8 of the session id>`. */
export function instanceName(settings: Pick<Settings, "name">, sessionId: string): string {
  if (settings.name) return settings.name;
  const short = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase();
  return `copilot-${short || "session"}`;
}

/**
 * Whether a verified sender id is on the allowlist. An entry is a full
 * agent id (`<account>.<user nkey>`) or just the user NKEY (`U…`).
 */
export function senderAllowed(allow: ReadonlyArray<string>, senderId: string): boolean {
  const user = senderId.slice(senderId.lastIndexOf(".") + 1);
  return allow.some((entry) => entry === senderId || entry === user);
}

/** The environment variable names worth asking the CLI for (it strips sensitive ones). */
export const REQUESTED_ENV_VARS = ["NATS_URL", "NATS_CREDS", "NATS_CREDENTIALS", "NATS_CONTEXT"];

function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//***@");
}

function parseBool(field: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`invalid ${field}: expected 1/0, true/false, yes/no or on/off`);
}

function positiveInt(field: string, value: unknown, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid ${field}: expected a whole number above 0`);
  return n;
}

function enumSetting<const T extends string>(field: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`invalid ${field}: expected ${allowed.map((v) => JSON.stringify(v)).join(" or ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: Record<string, unknown>, field: string): void {
  const candidate = value[field];
  if (candidate === undefined) return;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`invalid ${field}: expected a non-empty string`);
  }
}

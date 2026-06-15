import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { requireSubjectToken, sanitizeDerivedSubjectToken } from "./subject.js";
import { requireAttachedEndpointAuth } from "./endpoint.js";
import { defaultPluginConfig } from "./plugin-registrar.js";
import type {
  AgentConfig,
  CodexChannelConfig,
  CodexManagerConfig,
  CodexMapping,
  CodexMode,
  CodexPermissionPolicy,
  CodexPluginConfig,
  NatsConfig,
} from "./types.js";

export type {
  AgentConfig,
  CodexChannelConfig,
  CodexConfig,
  CodexManagerConfig,
  CodexMapping,
  CodexMode,
  CodexPermissionPolicy,
  CodexPluginConfig,
  NatsConfig,
} from "./types.js";

export interface ParsedArgs {
  readonly command: string;
  readonly config?: string;
  readonly natsUrl?: string;
  readonly natsContext?: string;
  readonly natsCreds?: string;
  readonly owner?: string;
  readonly session?: string;
  readonly subjectToken?: string;
  readonly mode?: CodexMode;
  readonly codexBin?: string;
  readonly codeHome?: string;
  readonly endpoint?: string;
  readonly endpointAuth?: string;
  readonly threadId?: string;
  readonly publicAlias?: string;
  readonly permissionPolicy?: CodexPermissionPolicy;
  readonly heartbeatIntervalS?: number;
  readonly keepaliveIntervalS?: number;
  readonly managerEnabled?: boolean;
  readonly autoExposeCurrentSessions?: boolean;
  readonly autoExposeFutureSessions?: boolean;
  readonly managerEndpoints?: readonly string[];
  readonly watchIntervalMs?: number;
  readonly staleGraceIntervals?: number;
  readonly exposeEphemeralLoadedSessions?: boolean;
  readonly pluginEnabled?: boolean;
  readonly pluginRegistrarHost?: string;
  readonly pluginRegistrarPort?: number;
  readonly pluginRegistrarToken?: string;
  readonly pluginHookPath?: string;
  readonly pluginStatePath?: string;
  readonly printTemplate?: boolean;
  readonly help?: boolean;
}

export interface LoadConfigSources {
  readonly argv?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly readFile?: (path: string) => string;
  readonly cwd?: string;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "synadia", "codex-nats-channel.toml");

const flagMap: Record<string, keyof Omit<ParsedArgs, "command">> = {
  "--config": "config",
  "--nats-url": "natsUrl",
  "--nats-context": "natsContext",
  "--nats-creds": "natsCreds",
  "--owner": "owner",
  "--session": "session",
  "--subject-token": "subjectToken",
  "--mode": "mode",
  "--codex-bin": "codexBin",
  "--code-home": "codeHome",
  "--endpoint": "endpoint",
  "--endpoint-auth": "endpointAuth",
  "--thread-id": "threadId",
  "--public-alias": "publicAlias",
  "--alias": "publicAlias",
  "--permission-policy": "permissionPolicy",
  "--heartbeat-interval-s": "heartbeatIntervalS",
  "--keepalive-interval-s": "keepaliveIntervalS",
  "--manager-enabled": "managerEnabled",
  "--auto-expose-current-sessions": "autoExposeCurrentSessions",
  "--auto-expose-future-sessions": "autoExposeFutureSessions",
  "--manager-endpoints": "managerEndpoints",
  "--watch-interval-ms": "watchIntervalMs",
  "--stale-grace-intervals": "staleGraceIntervals",
  "--expose-ephemeral-loaded-sessions": "exposeEphemeralLoadedSessions",
  "--plugin-enabled": "pluginEnabled",
  "--plugin-registrar-host": "pluginRegistrarHost",
  "--plugin-registrar-port": "pluginRegistrarPort",
  "--plugin-registrar-token": "pluginRegistrarToken",
  "--plugin-hook-path": "pluginHookPath",
  "--plugin-state-path": "pluginStatePath",
};

const numericFlags = new Set<keyof ParsedArgs>([
  "heartbeatIntervalS",
  "keepaliveIntervalS",
  "watchIntervalMs",
  "staleGraceIntervals",
  "pluginRegistrarPort",
]);
const booleanFlags = new Set<keyof ParsedArgs>([
  "managerEnabled",
  "autoExposeCurrentSessions",
  "autoExposeFutureSessions",
  "exposeEphemeralLoadedSessions",
  "pluginEnabled",
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [first = "help", ...rawRest] = argv;
  let command = first;
  let rest = rawRest;
  const out: Record<string, unknown> = {};
  if (first === "attach") {
    const subcommand = rawRest[0];
    if (subcommand !== "doctor" && subcommand !== "start") throw new Error("attach requires doctor or start");
    command = `attach:${subcommand}`;
    rest = rawRest.slice(1);
    out.mode = "attached";
  }
  out.command = command;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") { out.help = true; continue; }
    if (arg === "--print-template") { out.printTemplate = true; continue; }
    const key = flagMap[arg];
    if (!key) throw new Error(`unknown flag ${arg}`);
    const value = rest[++i];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (numericFlags.has(key)) {
      out[key] = parsePositiveNumber(value, arg);
    } else if (booleanFlags.has(key)) {
      out[key] = parseBoolean(value, arg);
    } else if (key === "managerEndpoints") {
      out[key] = splitList(value);
    } else if (key === "mode") {
      out[key] = parseCodexMode(value, arg);
    } else if (key === "permissionPolicy") {
      out[key] = parsePermissionPolicy(value, arg);
    } else {
      out[key] = value;
    }
  }
  return out as unknown as ParsedArgs;
}

type TomlTree = Record<string, Record<string, string>>;

// Tiny TOML reader for the adapter's generated config template: sections plus
// simple string/numeric/boolean key-value pairs with inline comments. It is not
// a general TOML parser; use the documented template shape for config files.
function parseTinyToml(source: string): TomlTree {
  const tree: TomlTree = {};
  let section = "";
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) { section = sec[1] ?? ""; tree[section] ??= {}; continue; }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+?)(?:\s+#.*)?$/.exec(line);
    if (!kv || !section) continue;
    const key = kv[1] ?? "";
    let value = (kv[2] ?? "").trim();
    value = value.replace(/^"|"$/g, "");
    tree[section]![key] = value;
  }
  return tree;
}

function readConfig(path: string, readFile: (path: string) => string): TomlTree {
  try {
    const source = readFile(path);
    return source ? parseTinyToml(source) : {};
  } catch {
    return {};
  }
}

const get = (...values: Array<string | undefined>): string | undefined => values.find((v) => v !== undefined && v !== "");

export function loadConfigFromSources(sources: LoadConfigSources = {}): CodexChannelConfig {
  const env = sources.env ?? process.env;
  const args = parseArgs(sources.argv ?? process.argv.slice(2));
  const cwd = sources.cwd ?? process.cwd();
  const configPath = args.config ?? env.SYNADIA_CODEX_CONFIG ?? DEFAULT_CONFIG_PATH;
  const readFile = sources.readFile ?? ((p: string) => existsSync(p) ? readFileSync(p, "utf8") : "");
  const file = readConfig(configPath, readFile);
  const natsSection = file.nats ?? {};
  const agentSection = file.agent ?? {};
  const codexSection = file.codex ?? {};
  const managerSection = file.manager ?? {};
  const pluginSection = file.plugin ?? {};

  const defaultSession = sanitizeDerivedSubjectToken(basename(resolve(cwd))) || "main";
  const owner = requireSubjectToken(get(args.owner, env.SYNADIA_CODEX_OWNER, agentSection.owner, sanitizeDerivedSubjectToken(env.USER ?? "unknown") || "unknown")!, "agent.owner");
  const subjectToken = requireSubjectToken(get(args.subjectToken, agentSection.subject_token, "codex")!, "agent.subject_token");
  if (subjectToken !== "codex") throw new Error("agent.subject_token must be codex for this adapter");

  const natsContext = get(args.natsContext, env.NATS_CONTEXT, natsSection.context);
  const natsCreds = get(args.natsCreds, env.NATS_CREDS, env.NATS_CREDENTIALS, natsSection.creds);
  const nats: NatsConfig = {
    url: get(args.natsUrl, env.NATS_URL, natsSection.url, "nats://127.0.0.1:4222")!,
    ...(natsContext ? { context: natsContext } : {}),
    ...(natsCreds ? { creds: natsCreds } : {}),
  };

  const codexMode = parseCodexMode(get(args.mode, env.SYNADIA_CODEX_MODE, codexSection.mode, "fake")!, "codex.mode");
  const codex = {
    mode: codexMode,
    codexBin: get(args.codexBin, env.SYNADIA_CODEX_BIN, codexSection.codex_bin, "codex")!,
    ...optional("codeHome", get(args.codeHome, env.SYNADIA_CODEX_HOME, codexSection.code_home)),
    ...optional("endpoint", get(args.endpoint, env.SYNADIA_CODEX_ENDPOINT, codexSection.endpoint)),
    ...optional("endpointAuth", get(args.endpointAuth, env.SYNADIA_CODEX_ENDPOINT_AUTH, codexSection.endpoint_auth)),
    ...optional("threadId", get(args.threadId, env.SYNADIA_CODEX_THREAD_ID, codexSection.thread_id)),
    ...optional("publicAlias", get(args.publicAlias, env.SYNADIA_CODEX_PUBLIC_ALIAS, codexSection.public_alias)),
    permissionPolicy: parsePermissionPolicy(get(args.permissionPolicy, env.SYNADIA_CODEX_PERMISSION_POLICY, codexSection.permission_policy, codexMode === "attached" ? "external-owner" : "reject")!, "codex.permission_policy"),
  };

  const sessionSource = codexMode === "attached"
    ? get(args.publicAlias, env.SYNADIA_CODEX_PUBLIC_ALIAS, codexSection.public_alias)
    : get(args.session, env.SYNADIA_CODEX_SESSION, agentSection.session, defaultSession);
  const session = requireSubjectToken(sessionSource ?? "", codexMode === "attached" ? "codex.public_alias" : "agent.session");
  validateAttachedConfig(codex);

  const agent: AgentConfig = {
    owner,
    session,
    subjectToken: "codex",
    heartbeatIntervalS: parsePositiveNumber(get(args.heartbeatIntervalS?.toString(), agentSection.heartbeat_interval_s, "30")!, "agent.heartbeat_interval_s"),
    keepaliveIntervalS: parsePositiveNumber(get(args.keepaliveIntervalS?.toString(), agentSection.keepalive_interval_s, "30")!, "agent.keepalive_interval_s"),
  };

  const manager: CodexManagerConfig = {
    enabled: parseBoolean(get(args.managerEnabled?.toString(), env.SYNADIA_CODEX_MANAGER_ENABLED, managerSection.enabled, "false")!, "manager.enabled"),
    autoExposeCurrentSessions: parseBoolean(get(args.autoExposeCurrentSessions?.toString(), env.SYNADIA_CODEX_AUTO_EXPOSE_CURRENT_SESSIONS, managerSection.auto_expose_current_sessions, "false")!, "manager.auto_expose_current_sessions"),
    autoExposeFutureSessions: parseBoolean(get(args.autoExposeFutureSessions?.toString(), env.SYNADIA_CODEX_AUTO_EXPOSE_FUTURE_SESSIONS, managerSection.auto_expose_future_sessions, "false")!, "manager.auto_expose_future_sessions"),
    endpoints: args.managerEndpoints ?? splitList(get(env.SYNADIA_CODEX_MANAGER_ENDPOINTS, managerSection.endpoints, "")!),
    watchMode: parseWatchMode(get(env.SYNADIA_CODEX_WATCH_MODE, managerSection.watch_mode, "event-plus-poll")!, "manager.watch_mode"),
    watchIntervalMs: parsePositiveNumber(get(args.watchIntervalMs?.toString(), env.SYNADIA_CODEX_WATCH_INTERVAL_MS, managerSection.watch_interval_ms, "7500")!, "manager.watch_interval_ms"),
    staleGraceIntervals: parsePositiveNumber(get(args.staleGraceIntervals?.toString(), env.SYNADIA_CODEX_STALE_GRACE_INTERVALS, managerSection.stale_grace_intervals, "3")!, "manager.stale_grace_intervals"),
    exposeEphemeralLoadedSessions: parseBoolean(get(args.exposeEphemeralLoadedSessions?.toString(), env.SYNADIA_CODEX_EXPOSE_EPHEMERAL_LOADED_SESSIONS, managerSection.expose_ephemeral_loaded_sessions, "false")!, "manager.expose_ephemeral_loaded_sessions"),
  };

  const pluginDefaults = defaultPluginConfig();
  const plugin: CodexPluginConfig = {
    enabled: parseBoolean(get(args.pluginEnabled?.toString(), env.SYNADIA_CODEX_PLUGIN_ENABLED, pluginSection.enabled, String(pluginDefaults.enabled))!, "plugin.enabled"),
    registrarHost: get(args.pluginRegistrarHost, env.SYNADIA_CODEX_PLUGIN_REGISTRAR_HOST, pluginSection.registrar_host, pluginDefaults.registrarHost)!,
    registrarPort: parsePositiveNumber(get(args.pluginRegistrarPort?.toString(), env.SYNADIA_CODEX_PLUGIN_REGISTRAR_PORT, pluginSection.registrar_port, String(pluginDefaults.registrarPort))!, "plugin.registrar_port"),
    ...optional("registrarToken", get(args.pluginRegistrarToken, env.SYNADIA_CODEX_PLUGIN_REGISTRAR_TOKEN, pluginSection.registrar_token)),
    ...optional("hookPath", get(args.pluginHookPath, env.SYNADIA_CODEX_PLUGIN_HOOK_PATH, pluginSection.hook_path)),
    ...optional("statePath", get(args.pluginStatePath, env.SYNADIA_CODEX_PLUGIN_STATE_PATH, pluginSection.state_path)),
  };

  return { nats, agent, codex, manager, plugin };
}

function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value ? { [key]: value } as Record<K, string> : {};
}

function validateAttachedConfig(codex: CodexChannelConfig["codex"]): void {
  if (codex.mode !== "attached") return;
  if (!codex.endpoint) throw new Error("attached mode requires --endpoint or SYNADIA_CODEX_ENDPOINT");
  if (!codex.threadId) throw new Error("attached mode requires --thread-id or SYNADIA_CODEX_THREAD_ID");
  if (!codex.publicAlias) throw new Error("attached mode requires --alias/--public-alias or SYNADIA_CODEX_PUBLIC_ALIAS");
  requireAttachedEndpointAuth(codex.endpoint, codex.endpointAuth);
}

function parsePositiveNumber(value: string, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be a positive number`);
  return number;
}

function parseBoolean(value: string, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${field} must be true or false`);
}

function splitList(value: string | undefined): readonly string[] {
  return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

function parseCodexMode(value: string, field: string): CodexMode {
  if (value === "fake" || value === "managed" || value === "attached" || value === "manager") return value;
  throw new Error(`${field} must be fake, managed, attached, or manager`);
}

function parsePermissionPolicy(value: string, field: string): CodexPermissionPolicy {
  if (value === "query" || value === "external-owner" || value === "reject" || value === "detect") return value;
  throw new Error(`${field} must be query, external-owner, reject, or detect`);
}

function parseWatchMode(value: string, field: string): CodexManagerConfig["watchMode"] {
  if (value === "event-plus-poll" || value === "poll") return value;
  throw new Error(`${field} must be event-plus-poll or poll`);
}

export function mappingFromConfig(config: CodexChannelConfig): CodexMapping {
  return {
    owner: config.agent.owner,
    session: config.agent.session,
    subjectToken: config.agent.subjectToken,
    codex: config.codex,
    manager: config.manager,
    ...(config.plugin ? { plugin: config.plugin } : {}),
  };
}

export function renderConfigTemplate(): string {
  return `[nats]
url = "nats://127.0.0.1:4222"
context = ""
creds = ""

[agent]
owner = "local"
session = "main"
# Protocol subject token is fixed for this adapter; changing it is rejected.
subject_token = "codex"
heartbeat_interval_s = 30
keepalive_interval_s = 30

[codex]
# Managed starts an adapter-owned isolated Codex app-server; fake is for protocol smoke tests.
mode = "managed"
codex_bin = "codex"
code_home = ""
endpoint = ""
endpoint_auth = ""
thread_id = ""
public_alias = ""
permission_policy = "reject"

[manager]
enabled = false
auto_expose_current_sessions = false
auto_expose_future_sessions = false
endpoints = ""
watch_mode = "event-plus-poll"
watch_interval_ms = 7500
stale_grace_intervals = 3
expose_ephemeral_loaded_sessions = false

[plugin]
# Optional acceleration lane: plugin notifications wake the manager, but never bypass app-server proof.
enabled = false
registrar_host = "127.0.0.1"
registrar_port = 8717
registrar_token = ""
hook_path = ""
state_path = ""
`;
}

export function helpText(): string {
  return `Usage: codex-agent <start|doctor|configure|attach doctor|attach start> [options]

Commands:
  start                 Register a Codex-shaped agent on NATS using the configured bridge mode
  doctor                Print redacted resolved config and managed app-server readiness
  configure --print-template
  attach doctor         Preflight an explicit endpoint + private thread + safe alias
  attach start          Register an explicit attached thread under its safe alias

Options:
  --config PATH
  --nats-url URL
  --nats-context NAME
  --nats-creds PATH
  --owner TOKEN
  --session TOKEN
  --subject-token codex
  --mode fake|managed|attached|manager
  --codex-bin PATH_OR_NAME
  --code-home PATH
  --endpoint URL_OR_SOCKET
  --endpoint-auth TOKEN
  --thread-id ID
  --public-alias TOKEN (or --alias TOKEN)
  --permission-policy query|external-owner|reject|detect
  --heartbeat-interval-s SECONDS
  --keepalive-interval-s SECONDS
  --manager-enabled true|false
  --auto-expose-current-sessions true|false
  --auto-expose-future-sessions true|false
  --manager-endpoints URL_OR_SOCKET[,URL_OR_SOCKET...]
  --watch-interval-ms MILLISECONDS
  --stale-grace-intervals COUNT
  --plugin-enabled true|false
  --plugin-registrar-host HOST
  --plugin-registrar-port PORT
  --plugin-registrar-token TOKEN
  --plugin-hook-path PATH
  --plugin-state-path PATH

Manager start accepts a stdin command 'rescan' to run an immediate inventory reconciliation.
`;
}

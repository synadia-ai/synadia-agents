import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { requireSubjectToken, sanitizeDerivedSubjectToken } from "./subject.js";
import type {
  AgentConfig,
  CodexChannelConfig,
  CodexManagerConfig,
  CodexMapping,
  CodexMode,
  CodexPermissionPolicy,
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
  readonly threadId?: string;
  readonly publicAlias?: string;
  readonly permissionPolicy?: CodexPermissionPolicy;
  readonly heartbeatIntervalS?: number;
  readonly keepaliveIntervalS?: number;
  readonly managerEnabled?: boolean;
  readonly autoExposeCurrentSessions?: boolean;
  readonly autoExposeFutureSessions?: boolean;
  readonly watchIntervalMs?: number;
  readonly staleGraceIntervals?: number;
  readonly exposeEphemeralLoadedSessions?: boolean;
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
  "--thread-id": "threadId",
  "--public-alias": "publicAlias",
  "--permission-policy": "permissionPolicy",
  "--heartbeat-interval-s": "heartbeatIntervalS",
  "--keepalive-interval-s": "keepaliveIntervalS",
  "--manager-enabled": "managerEnabled",
  "--auto-expose-current-sessions": "autoExposeCurrentSessions",
  "--auto-expose-future-sessions": "autoExposeFutureSessions",
  "--watch-interval-ms": "watchIntervalMs",
  "--stale-grace-intervals": "staleGraceIntervals",
  "--expose-ephemeral-loaded-sessions": "exposeEphemeralLoadedSessions",
};

const numericFlags = new Set<keyof ParsedArgs>([
  "heartbeatIntervalS",
  "keepaliveIntervalS",
  "watchIntervalMs",
  "staleGraceIntervals",
]);
const booleanFlags = new Set<keyof ParsedArgs>([
  "managerEnabled",
  "autoExposeCurrentSessions",
  "autoExposeFutureSessions",
  "exposeEphemeralLoadedSessions",
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const out: Record<string, unknown> = { command };
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

  const defaultSession = sanitizeDerivedSubjectToken(basename(resolve(cwd))) || "main";
  const owner = requireSubjectToken(get(args.owner, env.SYNADIA_CODEX_OWNER, agentSection.owner, sanitizeDerivedSubjectToken(env.USER ?? "unknown") || "unknown")!, "agent.owner");
  const session = requireSubjectToken(get(args.session, env.SYNADIA_CODEX_SESSION, agentSection.session, defaultSession)!, "agent.session");
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
    ...optional("threadId", get(args.threadId, env.SYNADIA_CODEX_THREAD_ID, codexSection.thread_id)),
    ...optional("publicAlias", get(args.publicAlias, env.SYNADIA_CODEX_PUBLIC_ALIAS, codexSection.public_alias)),
    permissionPolicy: parsePermissionPolicy(get(args.permissionPolicy, env.SYNADIA_CODEX_PERMISSION_POLICY, codexSection.permission_policy, "reject")!, "codex.permission_policy"),
  };

  const agent: AgentConfig = {
    owner,
    session,
    subjectToken: "codex",
    heartbeatIntervalS: parsePositiveNumber(get(args.heartbeatIntervalS?.toString(), agentSection.heartbeat_interval_s, "30")!, "agent.heartbeat_interval_s"),
    keepaliveIntervalS: parsePositiveNumber(get(args.keepaliveIntervalS?.toString(), agentSection.keepalive_interval_s, "30")!, "agent.keepalive_interval_s"),
  };

  const manager: CodexManagerConfig = {
    enabled: parseBoolean(get(args.managerEnabled?.toString(), managerSection.enabled, "false")!, "manager.enabled"),
    autoExposeCurrentSessions: parseBoolean(get(args.autoExposeCurrentSessions?.toString(), managerSection.auto_expose_current_sessions, "false")!, "manager.auto_expose_current_sessions"),
    autoExposeFutureSessions: parseBoolean(get(args.autoExposeFutureSessions?.toString(), managerSection.auto_expose_future_sessions, "false")!, "manager.auto_expose_future_sessions"),
    watchMode: parseWatchMode(get(managerSection.watch_mode, "event-plus-poll")!, "manager.watch_mode"),
    watchIntervalMs: parsePositiveNumber(get(args.watchIntervalMs?.toString(), managerSection.watch_interval_ms, "7500")!, "manager.watch_interval_ms"),
    staleGraceIntervals: parsePositiveNumber(get(args.staleGraceIntervals?.toString(), managerSection.stale_grace_intervals, "3")!, "manager.stale_grace_intervals"),
    exposeEphemeralLoadedSessions: parseBoolean(get(args.exposeEphemeralLoadedSessions?.toString(), managerSection.expose_ephemeral_loaded_sessions, "false")!, "manager.expose_ephemeral_loaded_sessions"),
  };

  return { nats, agent, codex, manager };
}

function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value ? { [key]: value } as Record<K, string> : {};
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
# Initial scaffold uses fake mode. Later work adds managed, attached, and manager runtimes.
mode = "fake"
codex_bin = "codex"
code_home = ""
endpoint = ""
thread_id = ""
public_alias = ""
permission_policy = "reject"

[manager]
enabled = false
auto_expose_current_sessions = false
auto_expose_future_sessions = false
watch_mode = "event-plus-poll"
watch_interval_ms = 7500
stale_grace_intervals = 3
expose_ephemeral_loaded_sessions = false
`;
}

export function helpText(): string {
  return `Usage: codex-agent <start|doctor|configure> [options]

Commands:
  start                 Register a Codex-shaped agent on NATS using the configured bridge mode
  doctor                Print redacted resolved config and Phase 1 readiness
  configure --print-template

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
  --thread-id ID
  --public-alias TOKEN
  --permission-policy query|external-owner|reject|detect
  --heartbeat-interval-s SECONDS
  --keepalive-interval-s SECONDS
`;
}

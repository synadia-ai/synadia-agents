import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { requireSubjectToken, sanitizeDerivedSubjectToken } from "./subject.js";
import type { NatsConfig, OpenCodeChannelConfig, OpenCodeMapping, OpenCodeMode, PermissionPolicy } from "./types.js";

export type { AgentConfig, NatsConfig, OpenCodeChannelConfig, OpenCodeConfig, OpenCodeMode, PermissionPolicy } from "./types.js";

export interface ParsedArgs {
  readonly command: string;
  readonly config?: string;
  readonly natsUrl?: string;
  readonly natsContext?: string;
  readonly natsCreds?: string;
  readonly owner?: string;
  readonly name?: string;
  readonly subjectToken?: string;
  readonly baseUrl?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly directory?: string;
  readonly workspace?: string;
  readonly serverPassword?: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly opencodeAgent?: string;
  readonly permissionPolicy?: PermissionPolicy;
  readonly permissionTimeoutMs?: number;
  readonly heartbeatIntervalS?: number;
  readonly keepaliveIntervalS?: number;
  readonly printTemplate?: boolean;
  readonly help?: boolean;
}

export interface LoadConfigSources {
  readonly argv?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly readFile?: (path: string) => string;
  readonly cwd?: string;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "synadia", "opencode-nats-channel.toml");

const flagMap: Record<string, keyof Omit<ParsedArgs, "command">> = {
  "--config": "config",
  "--nats-url": "natsUrl",
  "--nats-context": "natsContext",
  "--nats-creds": "natsCreds",
  "--owner": "owner",
  "--name": "name",
  "--session": "name",
  "--subject-token": "subjectToken",
  "--base-url": "baseUrl",
  "--hostname": "hostname",
  "--port": "port",
  "--directory": "directory",
  "--workspace": "workspace",
  "--server-password": "serverPassword",
  "--opencode-session-id": "sessionId",
  "--model": "model",
  "--opencode-agent": "opencodeAgent",
  "--permission-policy": "permissionPolicy",
  "--permission-timeout-ms": "permissionTimeoutMs",
  "--heartbeat-interval-s": "heartbeatIntervalS",
  "--keepalive-interval-s": "keepaliveIntervalS",
};

const numericFlags = new Set<keyof ParsedArgs>(["port", "permissionTimeoutMs", "heartbeatIntervalS", "keepaliveIntervalS"]);

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
    } else if (key === "permissionPolicy") {
      out[key] = parsePermissionPolicy(value, arg);
    } else {
      out[key] = value;
    }
  }
  return out as unknown as ParsedArgs;
}

type TomlTree = Record<string, Record<string, string>>;

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

export function loadConfigFromSources(sources: LoadConfigSources = {}): OpenCodeChannelConfig {
  const env = sources.env ?? process.env;
  const args = parseArgs(sources.argv ?? process.argv.slice(2));
  const cwd = sources.cwd ?? process.cwd();
  const configPath = args.config ?? env.SYNADIA_OPENCODE_CONFIG ?? DEFAULT_CONFIG_PATH;
  const readFile = sources.readFile ?? ((p: string) => existsSync(p) ? readFileSync(p, "utf8") : "");
  const file = readConfig(configPath, readFile);
  const natsSection = file.nats ?? {};
  const agentSection = file.agent ?? {};
  const opencodeSection = file.opencode ?? {};

  const defaultName = sanitizeDerivedSubjectToken(basename(resolve(cwd))) || "default";
  const owner = requireSubjectToken(get(args.owner, env.SYNADIA_OPENCODE_OWNER, agentSection.owner, sanitizeDerivedSubjectToken(env.USER ?? "unknown") || "unknown")!, "agent.owner");
  const name = requireSubjectToken(get(args.name, env.SYNADIA_OPENCODE_SESSION, agentSection.name, defaultName)!, "agent.name");
  const subjectToken = requireSubjectToken(get(args.subjectToken, agentSection.subject_token, "opencode")!, "agent.subject_token");
  if (subjectToken !== "opencode") throw new Error("agent.subject_token must be opencode for this adapter");

  const natsContext = get(args.natsContext, env.NATS_CONTEXT, natsSection.context);
  const natsCreds = get(args.natsCreds, env.NATS_CREDS, env.NATS_CREDENTIALS, natsSection.creds);
  const nats: NatsConfig = {
    url: get(args.natsUrl, env.NATS_URL, natsSection.url, "nats://127.0.0.1:4222")!,
    ...(natsContext ? { context: natsContext } : {}),
    ...(natsCreds ? { creds: natsCreds } : {}),
  };

  const baseUrl = get(args.baseUrl, env.OPENCODE_SERVER_URL, opencodeSection.base_url);
  const mode: OpenCodeMode = baseUrl ? "attached" : "managed";
  const directory = get(args.directory, env.OPENCODE_DIRECTORY, opencodeSection.directory, cwd);

  return {
    nats,
    agent: {
      owner,
      name,
      subjectToken: "opencode",
      heartbeatIntervalS: parsePositiveNumber(get(args.heartbeatIntervalS?.toString(), agentSection.heartbeat_interval_s, "30")!, "agent.heartbeat_interval_s"),
      keepaliveIntervalS: parsePositiveNumber(get(args.keepaliveIntervalS?.toString(), agentSection.keepalive_interval_s, "30")!, "agent.keepalive_interval_s"),
    },
    opencode: {
      mode,
      ...(baseUrl ? { baseUrl } : {}),
      hostname: get(args.hostname, env.OPENCODE_HOSTNAME, opencodeSection.hostname, "127.0.0.1")!,
      port: parsePositiveNumber(get(args.port?.toString(), env.OPENCODE_PORT, opencodeSection.port, "4096")!, "opencode.port"),
      ...optional("directory", directory),
      ...optional("workspace", get(args.workspace, env.OPENCODE_WORKSPACE, opencodeSection.workspace)),
      ...optional("serverPassword", get(args.serverPassword, env.OPENCODE_SERVER_PASSWORD, opencodeSection.server_password)),
      ...optional("sessionId", get(args.sessionId, env.OPENCODE_SESSION_ID, opencodeSection.opencode_session_id, opencodeSection.session_id)),
      ...optional("model", get(args.model, env.OPENCODE_MODEL, opencodeSection.model)),
      ...optional("agent", get(args.opencodeAgent, env.OPENCODE_AGENT, opencodeSection.opencode_agent, opencodeSection.agent)),
      permissionPolicy: parsePermissionPolicy(get(args.permissionPolicy, env.OPENCODE_PERMISSION_POLICY, opencodeSection.permission_policy, "query")!, "opencode.permission_policy"),
      permissionTimeoutMs: parsePositiveNumber(get(args.permissionTimeoutMs?.toString(), opencodeSection.permission_timeout_ms, "300000")!, "opencode.permission_timeout_ms"),
    },
  };
}

function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value ? { [key]: value } as Record<K, string> : {};
}

function parsePositiveNumber(value: string, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be a positive number`);
  return number;
}

function parsePermissionPolicy(value: string, field: string): PermissionPolicy {
  if (value === "query" || value === "local" || value === "reject") return value;
  throw new Error(`${field} must be query, local, or reject`);
}

export function mappingFromConfig(config: OpenCodeChannelConfig): OpenCodeMapping {
  return {
    owner: config.agent.owner,
    name: config.agent.name,
    subjectToken: config.agent.subjectToken,
    opencode: config.opencode,
  };
}

export function renderConfigTemplate(): string {
  return `[nats]
url = "nats://127.0.0.1:4222"
context = "local"
creds = "/path/to/user.creds"

[agent]
owner = "rene"
name = "labrowser"
subject_token = "opencode"
heartbeat_interval_s = 30
keepalive_interval_s = 30

[opencode]
# Leave base_url empty for managed mode.
# Set it for power-user attached mode, e.g. http://127.0.0.1:4096.
base_url = ""
hostname = "127.0.0.1"
port = 4096
directory = "/path/to/repo"
workspace = ""
opencode_session_id = ""
model = ""
opencode_agent = ""
permission_policy = "query"
permission_timeout_ms = 300000
`;
}

export function helpText(): string {
  return `Usage: opencode-agent <start|doctor|configure> [options]

Commands:
  start                 Register an OpenCode-backed agent on NATS
  doctor                Check resolved config and local/attached prerequisites
  configure --print-template

Options:
  --config PATH
  --nats-url URL
  --nats-context NAME
  --nats-creds PATH
  --owner TOKEN
  --session TOKEN        Alias for --name
  --name TOKEN
  --subject-token opencode
  --base-url URL         Attached mode; do not spawn opencode serve
  --hostname HOST        Managed mode hostname
  --port PORT            Managed mode port
  --directory PATH
  --workspace NAME
  --server-password VALUE
  --opencode-session-id ID
  --model MODEL
  --opencode-agent NAME
  --permission-policy query|local|reject
`;
}

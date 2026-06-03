import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOwner, requireSubjectToken, sanitizeSubjectToken } from "./subject.js";

export type FlueTransport = "websocket" | "http-sync" | "http-stream";

export interface NatsConfig {
  readonly url?: string;
  readonly context?: string;
  readonly creds?: string;
}

export interface AgentConfig {
  readonly owner: string;
  readonly name: string;
  readonly subjectToken: string;
  readonly heartbeatIntervalS: number;
  readonly keepaliveIntervalS: number;
}

export interface FlueTargetConfig {
  readonly baseUrl: string;
  readonly agent: string;
  readonly instance: string;
  readonly session: string;
  readonly transport: FlueTransport;
}

export interface FlueChannelConfig {
  readonly nats: NatsConfig;
  readonly agent: AgentConfig;
  readonly flue: FlueTargetConfig;
}

export interface FlueMapping {
  readonly owner: string;
  readonly name: string;
  readonly subjectToken: string;
  readonly flue: FlueTargetConfig;
}

export interface ParsedArgs {
  readonly command: string;
  readonly config?: string;
  readonly natsUrl?: string;
  readonly natsContext?: string;
  readonly natsCreds?: string;
  readonly owner?: string;
  readonly name?: string;
  readonly subjectToken?: string;
  readonly flueBaseUrl?: string;
  readonly flueAgent?: string;
  readonly flueInstance?: string;
  readonly flueSession?: string;
  readonly flueTransport?: FlueTransport;
  readonly heartbeatIntervalS?: number;
  readonly keepaliveIntervalS?: number;
  readonly printTemplate?: boolean;
  readonly help?: boolean;
}

export interface LoadConfigSources {
  readonly argv?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly readFile?: (path: string) => string;
}

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "synadia", "flue-nats-channel.toml");

const flagMap: Record<string, keyof Omit<ParsedArgs, "command">> = {
  "--config": "config",
  "--nats-url": "natsUrl",
  "--nats-context": "natsContext",
  "--nats-creds": "natsCreds",
  "--owner": "owner",
  "--name": "name",
  "--subject-token": "subjectToken",
  "--flue-base-url": "flueBaseUrl",
  "--flue-agent": "flueAgent",
  "--flue-instance": "flueInstance",
  "--flue-session": "flueSession",
  "--flue-transport": "flueTransport",
  "--heartbeat-interval-s": "heartbeatIntervalS",
  "--keepalive-interval-s": "keepaliveIntervalS",
};

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
    if (key === "heartbeatIntervalS" || key === "keepaliveIntervalS") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${arg} must be a positive number`);
      out[key] = n;
    } else if (key === "flueTransport") {
      if (!isFlueTransport(value)) throw new Error(`${arg} must be websocket, http-sync, or http-stream`);
      out[key] = value;
    } else {
      out[key] = value;
    }
  }
  return out as unknown as ParsedArgs;
}

function isFlueTransport(value: string): value is FlueTransport {
  return value === "websocket" || value === "http-sync" || value === "http-stream";
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
    return parseTinyToml(readFile(path));
  } catch {
    return {};
  }
}

const get = (...values: Array<string | undefined>): string | undefined => values.find((v) => v !== undefined && v !== "");

export function loadConfigFromSources(sources: LoadConfigSources = {}): FlueChannelConfig {
  const env = sources.env ?? process.env;
  const args = parseArgs(sources.argv ?? process.argv.slice(2));
  const configPath = args.config ?? env.SYNADIA_FLUE_CONFIG ?? DEFAULT_CONFIG_PATH;
  const readFile = sources.readFile ?? ((p: string) => existsSync(p) ? readFileSync(p, "utf8") : "");
  const file = readConfig(configPath, readFile);
  const natsSection = file.nats ?? {};
  const agentSection = file.agent ?? {};
  const flueSection = file.flue ?? {};

  const owner = resolveOwner(get(args.owner, env.SYNADIA_FLUE_OWNER, agentSection.owner, env.USER), undefined, undefined);
  const name = requireSubjectToken(get(args.name, env.SYNADIA_FLUE_NAME, agentSection.name, "main")!, "agent.name");
  const subjectToken = requireSubjectToken(get(args.subjectToken, agentSection.subject_token, "flue")!, "agent.subject_token");
  const transport = get(args.flueTransport, env.FLUE_TRANSPORT, flueSection.transport, "http-stream")!;
  if (!isFlueTransport(transport)) throw new Error(`invalid flue transport ${transport}`);

  const nats: Record<string, string> = {};
  const natsUrl = get(args.natsUrl, env.NATS_URL, natsSection.url, "nats://127.0.0.1:4222");
  const natsContext = get(args.natsContext, env.NATS_CONTEXT, natsSection.context);
  const natsCreds = get(args.natsCreds, env.NATS_CREDS, env.NATS_CREDENTIALS, natsSection.creds);
  if (natsUrl) nats.url = natsUrl;
  if (natsContext) nats.context = natsContext;
  if (natsCreds) nats.creds = natsCreds;

  return {
    nats,
    agent: {
      owner,
      name,
      subjectToken,
      heartbeatIntervalS: parsePositiveNumber(get(args.heartbeatIntervalS?.toString(), agentSection.heartbeat_interval_s, "30")!, "agent.heartbeat_interval_s"),
      keepaliveIntervalS: parsePositiveNumber(get(args.keepaliveIntervalS?.toString(), agentSection.keepalive_interval_s, "30")!, "agent.keepalive_interval_s"),
    },
    flue: {
      baseUrl: get(args.flueBaseUrl, env.FLUE_BASE_URL, flueSection.base_url, "http://127.0.0.1:3583")!,
      agent: get(args.flueAgent, env.FLUE_AGENT, flueSection.agent, "assistant")!,
      instance: get(args.flueInstance, env.FLUE_INSTANCE, flueSection.instance, "default")!,
      session: get(args.flueSession, env.FLUE_SESSION, flueSection.session, "default")!,
      transport,
    },
  };
}

function parsePositiveNumber(value: string, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be a positive number`);
  return number;
}

export function mappingFromConfig(config: FlueChannelConfig): FlueMapping {
  return {
    owner: config.agent.owner,
    name: config.agent.name,
    subjectToken: sanitizeSubjectToken(config.agent.subjectToken) || "flue",
    flue: config.flue,
  };
}

export function renderConfigTemplate(): string {
  return `[nats]
url = "nats://127.0.0.1:4222"
context = "local"
creds = "/path/to/user.creds"

[agent]
owner = "rene"
name = "support"
subject_token = "flue"
heartbeat_interval_s = 30
keepalive_interval_s = 30

[flue]
base_url = "http://127.0.0.1:3583"
agent = "assistant"
instance = "customer-123"
session = "ticket-123"
transport = "http-stream"
`;
}

export function helpText(): string {
  return `Usage: flue-nats-channel <start|doctor|configure> [options]

Commands:
  start                 Register the Flue-backed agent on NATS
  doctor                Check config and Flue reachability
  configure --print-template

Options:
  --config PATH
  --nats-url URL
  --nats-context NAME
  --nats-creds PATH
  --owner TOKEN
  --name TOKEN
  --subject-token TOKEN
  --flue-base-url URL
  --flue-agent NAME
  --flue-instance ID
  --flue-session SESSION
  --flue-transport websocket|http-sync|http-stream
`;
}

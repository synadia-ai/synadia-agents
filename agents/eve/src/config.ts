import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOwner, requireSubjectToken, sanitizeSubjectToken } from "./subject.js";

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

export interface EveTargetConfig {
  readonly baseUrl: string;
  /** Bearer token for deployed Eve agents. Unset for local `eve dev`. */
  readonly authToken?: string;
  /** §7 mid-stream query timeout for Eve HITL input requests. */
  readonly askTimeoutS: number;
}

export interface EveChannelConfig {
  readonly nats: NatsConfig;
  readonly agent: AgentConfig;
  readonly eve: EveTargetConfig;
}

export interface EveMapping {
  readonly owner: string;
  readonly name: string;
  readonly subjectToken: string;
  readonly eve: EveTargetConfig;
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
  readonly eveBaseUrl?: string;
  readonly eveAuthToken?: string;
  readonly askTimeoutS?: number;
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

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "synadia", "eve-nats-channel.toml");
export const DEFAULT_EVE_BASE_URL = "http://127.0.0.1:2000";
export const DEFAULT_ASK_TIMEOUT_S = 120;

const flagMap: Record<string, keyof Omit<ParsedArgs, "command">> = {
  "--config": "config",
  "--nats-url": "natsUrl",
  "--nats-context": "natsContext",
  "--nats-creds": "natsCreds",
  "--owner": "owner",
  "--name": "name",
  "--subject-token": "subjectToken",
  "--eve-base-url": "eveBaseUrl",
  "--eve-auth-token": "eveAuthToken",
  "--ask-timeout-s": "askTimeoutS",
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
    if (key === "heartbeatIntervalS" || key === "keepaliveIntervalS" || key === "askTimeoutS") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${arg} must be a positive number`);
      out[key] = n;
    } else {
      out[key] = value;
    }
  }
  return out as unknown as ParsedArgs;
}

type TomlTree = Record<string, Record<string, string>>;

// Deliberately tiny section-scoped grammar (shared with the sibling
// channels): keys before the first `[section]` header are ignored — every
// recognized key lives under [nats], [agent], or [eve].
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

export function loadConfigFromSources(sources: LoadConfigSources = {}): EveChannelConfig {
  const env = sources.env ?? process.env;
  const args = parseArgs(sources.argv ?? process.argv.slice(2));
  const configPath = args.config ?? env.SYNADIA_EVE_CONFIG ?? DEFAULT_CONFIG_PATH;
  const readFile = sources.readFile ?? ((p: string) => existsSync(p) ? readFileSync(p, "utf8") : "");
  const file = readConfig(configPath, readFile);
  const natsSection = file.nats ?? {};
  const agentSection = file.agent ?? {};
  const eveSection = file.eve ?? {};

  // Identity chain per the SYNADIA_* convention shared across agents/*:
  // CLI flag > per-agent var > fleet-wide var (SYNADIA_OWNER / SYNADIA_NAME)
  // > config file > derived fallback.
  const owner = resolveOwner(get(args.owner, env.SYNADIA_EVE_OWNER, env.SYNADIA_OWNER, agentSection.owner, env.USER), undefined, undefined);
  const name = requireSubjectToken(get(args.name, env.SYNADIA_EVE_NAME, env.SYNADIA_NAME, agentSection.name, "main")!, "agent.name");
  const subjectToken = requireSubjectToken(get(args.subjectToken, agentSection.subject_token, "eve")!, "agent.subject_token");

  const nats: Record<string, string> = {};
  const natsUrl = get(args.natsUrl, env.NATS_URL, natsSection.url, "nats://127.0.0.1:4222");
  const natsContext = get(args.natsContext, env.NATS_CONTEXT, natsSection.context);
  const natsCreds = get(args.natsCreds, env.NATS_CREDS, env.NATS_CREDENTIALS, natsSection.creds);
  if (natsUrl) nats.url = natsUrl;
  if (natsContext) nats.context = natsContext;
  if (natsCreds) nats.creds = natsCreds;

  const authToken = get(args.eveAuthToken, env.EVE_AUTH_TOKEN, eveSection.auth_token);

  return {
    nats,
    agent: {
      owner,
      name,
      subjectToken,
      heartbeatIntervalS: parsePositiveNumber(get(args.heartbeatIntervalS?.toString(), agentSection.heartbeat_interval_s, "30")!, "agent.heartbeat_interval_s"),
      keepaliveIntervalS: parsePositiveNumber(get(args.keepaliveIntervalS?.toString(), agentSection.keepalive_interval_s, "30")!, "agent.keepalive_interval_s"),
    },
    eve: {
      baseUrl: get(args.eveBaseUrl, env.EVE_BASE_URL, eveSection.base_url, DEFAULT_EVE_BASE_URL)!,
      ...(authToken !== undefined ? { authToken } : {}),
      askTimeoutS: parsePositiveNumber(get(args.askTimeoutS?.toString(), env.EVE_ASK_TIMEOUT_S, eveSection.ask_timeout_s, String(DEFAULT_ASK_TIMEOUT_S))!, "eve.ask_timeout_s"),
    },
  };
}

function parsePositiveNumber(value: string, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be a positive number`);
  return number;
}

export function mappingFromConfig(config: EveChannelConfig): EveMapping {
  return {
    owner: config.agent.owner,
    name: config.agent.name,
    subjectToken: sanitizeSubjectToken(config.agent.subjectToken) || "eve",
    eve: config.eve,
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
subject_token = "eve"
heartbeat_interval_s = 30
keepalive_interval_s = 30

[eve]
base_url = "http://127.0.0.1:2000"
# auth_token = "bearer-token-for-deployed-agents"
ask_timeout_s = 120
`;
}

export function helpText(): string {
  return `Usage: eve-agent <start|doctor|configure> [options]

Commands:
  start                 Register the Eve-backed agent on NATS
  doctor                Check config and Eve reachability
  configure --print-template

Options:
  --config PATH
  --nats-url URL
  --nats-context NAME
  --nats-creds PATH
  --owner TOKEN
  --name TOKEN
  --subject-token TOKEN
  --eve-base-url URL
  --eve-auth-token TOKEN   (prefer EVE_AUTH_TOKEN or the TOML file:
                            flags are visible in process listings)
  --ask-timeout-s SECONDS
  --heartbeat-interval-s SECONDS
  --keepalive-interval-s SECONDS
`;
}

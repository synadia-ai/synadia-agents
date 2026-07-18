import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { resolvePreset, presetKeys, type AcpAgentPreset } from "./presets.js";
import { requireSubjectToken, sanitizeDerivedSubjectToken } from "./subject.js";
import type {
  AcpChannelConfig,
  AcpMapping,
  AcpMode,
  AcpPermissionPolicy,
  AcpRuntimeConfig,
  AgentIdentityConfig,
  NatsConfig,
} from "./types.js";

export type {
  AcpChannelConfig,
  AcpMapping,
  AcpMode,
  AcpPermissionPolicy,
  AcpRuntimeConfig,
  AgentIdentityConfig,
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
  readonly agent?: string;
  readonly agentId?: string;
  readonly mode?: AcpMode;
  readonly acpBin?: string;
  readonly acpArgs?: string;
  readonly agentHome?: string;
  readonly acpCwd?: string;
  readonly permissionPolicy?: AcpPermissionPolicy;
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

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "synadia", "acp-nats-channel.toml");

const flagMap: Record<string, keyof Omit<ParsedArgs, "command">> = {
  "--config": "config",
  "--nats-url": "natsUrl",
  "--nats-context": "natsContext",
  "--nats-creds": "natsCreds",
  "--owner": "owner",
  "--session": "session",
  "--subject-token": "subjectToken",
  "--agent": "agent",
  "--agent-id": "agentId",
  "--mode": "mode",
  "--acp-bin": "acpBin",
  "--acp-args": "acpArgs",
  "--agent-home": "agentHome",
  "--cwd": "acpCwd",
  "--permission-policy": "permissionPolicy",
  "--heartbeat-interval-s": "heartbeatIntervalS",
  "--keepalive-interval-s": "keepaliveIntervalS",
};

const numericFlags = new Set<keyof ParsedArgs>(["heartbeatIntervalS", "keepaliveIntervalS"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [first = "help", ...rest] = argv;
  const out: Record<string, unknown> = { command: first };
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
    } else if (key === "mode") {
      out[key] = parseAcpMode(value, arg);
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
// Mirrors agents/codex/src/config.ts.
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

export function loadConfigFromSources(sources: LoadConfigSources = {}): AcpChannelConfig {
  const env = sources.env ?? process.env;
  const args = parseArgs(sources.argv ?? process.argv.slice(2));
  const cwd = sources.cwd ?? process.cwd();
  const configPath = args.config ?? env.SYNADIA_ACP_CONFIG ?? DEFAULT_CONFIG_PATH;
  const readFile = sources.readFile ?? ((p: string) => existsSync(p) ? readFileSync(p, "utf8") : "");
  const file = readConfig(configPath, readFile);
  const natsSection = file.nats ?? {};
  const agentSection = file.agent ?? {};
  const acpSection = file.acp ?? {};

  // Preset resolves first — the per-agent SYNADIA_<AGENT>_* env vars below
  // depend on which preset is active.
  const presetKey = get(args.agent, env.SYNADIA_ACP_AGENT, acpSection.agent, "grok")!;
  const preset: AcpAgentPreset | undefined = presetKey === "custom" ? undefined : resolvePreset(presetKey);
  if (presetKey !== "custom" && preset === undefined) {
    throw new Error(`acp.agent must be one of: ${presetKeys()}`);
  }
  // Per-agent identity env var lookup (SYNADIA_GROK_OWNER etc.). Custom
  // agents only have the channel-level SYNADIA_ACP_* vars.
  const perAgent = (suffix: string): string | undefined =>
    preset ? env[`${preset.envPrefix}_${suffix}`] : undefined;

  const defaultSession = sanitizeDerivedSubjectToken(basename(resolve(cwd))) || "main";
  // Identity precedence (SYNADIA_* convention shared across agents/*):
  // CLI > per-agent env > channel env (SYNADIA_ACP_*) > fleet-wide env > file > derived.
  const owner = requireSubjectToken(
    get(args.owner, perAgent("OWNER"), env.SYNADIA_ACP_OWNER, env.SYNADIA_OWNER, agentSection.owner, sanitizeDerivedSubjectToken(env.USER ?? "unknown") || "unknown")!,
    "agent.owner",
  );
  const session = requireSubjectToken(
    get(args.session, perAgent("SESSION"), env.SYNADIA_ACP_SESSION, env.SYNADIA_NAME, agentSection.session, defaultSession)!,
    "agent.session",
  );

  // Unlike the codex adapter, the subject token is per-preset, not fixed:
  // the ACP channel hosts many agent identities. Overrides are validated,
  // never rewritten.
  const agentId = preset
    ? preset.agentId
    : requireSubjectToken(
        get(args.agentId, env.SYNADIA_ACP_AGENT_ID, acpSection.agent_id) ?? missing("custom agent requires --agent-id (metadata.agent identifier)"),
        "acp.agent_id",
      );
  const subjectToken = requireSubjectToken(
    get(args.subjectToken, acpSection.subject_token, preset ? preset.subjectToken : agentId)!,
    "agent.subject_token",
  );

  const natsContext = get(args.natsContext, env.NATS_CONTEXT, natsSection.context);
  const natsCreds = get(args.natsCreds, env.NATS_CREDS, env.NATS_CREDENTIALS, natsSection.creds);
  const nats: NatsConfig = {
    url: get(args.natsUrl, env.NATS_URL, natsSection.url, "nats://127.0.0.1:4222")!,
    ...(natsContext ? { context: natsContext } : {}),
    ...(natsCreds ? { creds: natsCreds } : {}),
  };

  const bin = get(args.acpBin, perAgent("BIN"), env.SYNADIA_ACP_BIN, acpSection.bin, preset?.bin)
    ?? missing("custom agent requires --acp-bin (binary to spawn in ACP stdio mode)");
  const rawArgs = get(args.acpArgs, perAgent("ARGS"), env.SYNADIA_ACP_ARGS, acpSection.args);
  const acpArgs: readonly string[] = rawArgs !== undefined
    ? rawArgs.split(/\s+/).filter(Boolean)
    : preset?.args ?? [];

  const agentHome = get(args.agentHome, perAgent("HOME"), env.SYNADIA_ACP_HOME, acpSection.agent_home);
  if (agentHome !== undefined && preset?.homeEnvVar === undefined) {
    throw new Error(
      `acp.agent_home requires a preset with a home env var (currently: grok via GROK_HOME); ` +
      `for other agents point the agent at its home through your own environment`,
    );
  }

  const acpMode = parseAcpMode(get(args.mode, env.SYNADIA_ACP_MODE, acpSection.mode, "fake")!, "acp.mode");
  const acp: AcpRuntimeConfig = {
    mode: acpMode,
    preset: presetKey,
    agentId,
    bin,
    args: acpArgs,
    ...(preset?.homeEnvVar !== undefined ? { homeEnvVar: preset.homeEnvVar } : {}),
    ...(agentHome !== undefined ? { agentHome } : {}),
    cwd: resolve(get(args.acpCwd, env.SYNADIA_ACP_CWD, acpSection.cwd) ?? cwd),
    permissionPolicy: parsePermissionPolicy(
      get(args.permissionPolicy, perAgent("PERMISSION_POLICY"), env.SYNADIA_ACP_PERMISSION_POLICY, acpSection.permission_policy, "reject")!,
      "acp.permission_policy",
    ),
  };

  const agent: AgentIdentityConfig = {
    owner,
    session,
    subjectToken,
    heartbeatIntervalS: parsePositiveNumber(get(args.heartbeatIntervalS?.toString(), agentSection.heartbeat_interval_s, "30")!, "agent.heartbeat_interval_s"),
    keepaliveIntervalS: parsePositiveNumber(get(args.keepaliveIntervalS?.toString(), agentSection.keepalive_interval_s, "30")!, "agent.keepalive_interval_s"),
  };

  return { nats, agent, acp };
}

function missing(message: string): never {
  throw new Error(message);
}

function parsePositiveNumber(value: string, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be a positive number`);
  return number;
}

function parseAcpMode(value: string, field: string): AcpMode {
  if (value === "fake" || value === "managed") return value;
  throw new Error(`${field} must be fake or managed`);
}

function parsePermissionPolicy(value: string, field: string): AcpPermissionPolicy {
  if (value === "reject" || value === "query" || value === "allow") return value;
  throw new Error(`${field} must be reject, query, or allow`);
}

export function mappingFromConfig(config: AcpChannelConfig): AcpMapping {
  return {
    owner: config.agent.owner,
    session: config.agent.session,
    subjectToken: config.agent.subjectToken,
    acp: config.acp,
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
# Defaults to the preset's token (grok -> "grok", gemini -> "gemini").
subject_token = ""
heartbeat_interval_s = 30
keepalive_interval_s = 30

[acp]
# Preset: grok or custom (custom requires agent_id + bin).
agent = "grok"
# Managed spawns an adapter-owned ACP agent subprocess; fake is for protocol smoke tests.
mode = "managed"
bin = ""
args = ""
agent_id = ""
# Point at an already-authenticated agent home (e.g. ~/.grok) to reuse auth.
# Leave empty for an ephemeral isolated home (removed on shutdown).
agent_home = ""
# Working directory for the ACP session. Defaults to the process cwd.
cwd = ""
permission_policy = "reject"
`;
}

export function helpText(): string {
  return `Usage: acp-agent <start|doctor|configure> [options]

Commands:
  start                 Register an ACP-backed agent on NATS using the configured bridge mode
  doctor                Print resolved config and ACP binary readiness
  configure --print-template

Options:
  --config PATH
  --nats-url URL
  --nats-context NAME
  --nats-creds PATH
  --owner TOKEN
  --session TOKEN
  --subject-token TOKEN
  --agent ${presetKeys()}
  --agent-id TOKEN          (custom preset: metadata.agent identifier)
  --mode fake|managed
  --acp-bin PATH_OR_NAME
  --acp-args "ARGS..."      (space-separated, e.g. "agent stdio")
  --agent-home PATH         (reuse an authenticated agent home, e.g. ~/.grok)
  --cwd PATH                (working directory for the ACP session)
  --permission-policy reject|query|allow
  --heartbeat-interval-s SECONDS
  --keepalive-interval-s SECONDS

Presets spawn: grok -> \`grok agent stdio\` (GROK_HOME isolated per run unless
--agent-home is set). Use --agent custom with --agent-id/--acp-bin for any
other ACP-speaking agent or adapter (e.g. Antigravity via an ACP adapter).
`;
}

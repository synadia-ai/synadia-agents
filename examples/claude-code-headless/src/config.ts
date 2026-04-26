// Config loading for claude-code-headless.
//
// Precedence (high → low):
//   1. CLI flags
//   2. Environment variables
//   3. ~/.claude-code-headless/config.json
//   4. Built-in defaults
//
// NATS connectivity: a `context` name is preferred; if absent, `NATS_URL`
// serves as a fallback.

import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export interface ClaudeCodeHeadlessConfig {
  /** NATS CLI context name. Empty/undefined means "use NATS_URL only". */
  readonly context?: string;
  /** Explicit NATS URL; used only when `context` is unset. */
  readonly natsUrl?: string;
  /** Owner token (3rd subject segment). Defaults to $USER. */
  readonly owner: string;
  /** Controller instance name (4th subject token for the controller). */
  readonly name: string;
  /** Default Claude model id for spawns that don't set one. */
  readonly defaultModel: string;
  /** Default permission mode for spawned sessions. */
  readonly defaultPermissionMode: string;
  /** Default tool allowlist for spawned sessions. */
  readonly defaultAllowedTools: ReadonlyArray<string>;
  /** Default safety cap on turns per prompt. */
  readonly defaultMaxTurns: number;
  /** Default session lifetime in seconds. 0 means unbounded. */
  readonly defaultMaxLifetimeS: number;
}

const CONFIG_FILE = join(homedir(), ".claude-code-headless", "config.json");

const BUILT_IN_DEFAULTS = {
  name: "exec",
  // Sonnet is the right cost/quality default for a per-request spawner;
  // callers can override per-spawn or via config.json.
  defaultModel: "claude-sonnet-4-6",
  // `dontAsk` means: no permission prompts ever. Anything not in the
  // allowlist is denied. Deterministic, headless-friendly default.
  defaultPermissionMode: "dontAsk",
  // Read-only by default; reference implementation should be safe out of
  // the box. Callers can expand per-spawn.
  defaultAllowedTools: ["Read", "Glob", "Grep"] as ReadonlyArray<string>,
  defaultMaxTurns: 50,
  defaultMaxLifetimeS: 1800,
} as const;

interface RawConfigFile {
  context?: string;
  name?: string;
  defaultModel?: string;
  defaultPermissionMode?: string;
  defaultAllowedTools?: ReadonlyArray<string>;
  defaultMaxTurns?: number;
  defaultMaxLifetimeS?: number;
}

function readConfigFile(): RawConfigFile {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as RawConfigFile;
  } catch (e) {
    process.stderr.write(
      `claude-code-headless: failed to read ${CONFIG_FILE}: ${(e as Error).message}\n`,
    );
    return {};
  }
}

export interface CliOverrides {
  context?: string;
  natsUrl?: string;
  owner?: string;
  name?: string;
}

/** Parse simple `--key value` / `--key=value` CLI flags. Unknown flags are ignored. */
export function parseCliOverrides(argv: ReadonlyArray<string>): CliOverrides {
  const out: CliOverrides = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith("--")) continue;
    let key: string;
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      value = argv[i + 1];
      if (value !== undefined && value.startsWith("--")) value = undefined;
      else if (value !== undefined) i += 1;
    }
    if (value === undefined) continue;
    switch (key) {
      case "context":
        out.context = value;
        break;
      case "nats-url":
      case "url":
        out.natsUrl = value;
        break;
      case "owner":
        out.owner = value;
        break;
      case "name":
        out.name = value;
        break;
    }
  }
  return out;
}

function parseToolList(input: string | undefined): ReadonlyArray<string> | undefined {
  if (!input) return undefined;
  const items = input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

export function loadConfig(cli: CliOverrides = {}): ClaudeCodeHeadlessConfig {
  const file = readConfigFile();
  const env = process.env;

  const owner =
    cli.owner ??
    env["CLAUDE_CODE_HEADLESS_OWNER"] ??
    env["USER"] ??
    userInfo().username ??
    "anon";
  const name =
    cli.name ?? env["CLAUDE_CODE_HEADLESS_NAME"] ?? file.name ?? BUILT_IN_DEFAULTS.name;
  const context = cli.context ?? env["NATS_CONTEXT"] ?? file.context;
  const natsUrl = cli.natsUrl ?? env["NATS_URL"];
  const defaultModel =
    env["CLAUDE_CODE_HEADLESS_DEFAULT_MODEL"] ??
    file.defaultModel ??
    BUILT_IN_DEFAULTS.defaultModel;
  const defaultPermissionMode =
    env["CLAUDE_CODE_HEADLESS_DEFAULT_PERMISSION_MODE"] ??
    file.defaultPermissionMode ??
    BUILT_IN_DEFAULTS.defaultPermissionMode;
  const defaultAllowedTools =
    parseToolList(env["CLAUDE_CODE_HEADLESS_DEFAULT_ALLOWED_TOOLS"]) ??
    file.defaultAllowedTools ??
    BUILT_IN_DEFAULTS.defaultAllowedTools;
  const maxTurnsEnv = env["CLAUDE_CODE_HEADLESS_DEFAULT_MAX_TURNS"];
  const defaultMaxTurns =
    (maxTurnsEnv ? Number(maxTurnsEnv) : undefined) ??
    file.defaultMaxTurns ??
    BUILT_IN_DEFAULTS.defaultMaxTurns;
  const maxLifetimeEnv = env["CLAUDE_CODE_HEADLESS_DEFAULT_MAX_LIFETIME"];
  const defaultMaxLifetimeS =
    (maxLifetimeEnv ? Number(maxLifetimeEnv) : undefined) ??
    file.defaultMaxLifetimeS ??
    BUILT_IN_DEFAULTS.defaultMaxLifetimeS;

  if (!context && !natsUrl) {
    throw new Error(
      "claude-code-headless: no NATS target configured. Set --context, NATS_CONTEXT, or NATS_URL.",
    );
  }

  return {
    ...(context ? { context } : {}),
    ...(natsUrl ? { natsUrl } : {}),
    owner,
    name,
    defaultModel,
    defaultPermissionMode,
    defaultAllowedTools,
    defaultMaxTurns,
    defaultMaxLifetimeS,
  };
}

// Config loading for pi-headless.
//
// Precedence (high → low):
//   1. CLI flags
//   2. Environment variables
//   3. ~/.pi-headless/config.json
//   4. Built-in defaults
//
// NATS connectivity: a `context` name is preferred; if absent, `NATS_URL`
// serves as a fallback.

import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export interface PiHeadlessConfig {
  /** NATS CLI context name. Empty/undefined means "use NATS_URL only". */
  readonly context?: string;
  /** Explicit NATS URL; used only when `context` is unset. */
  readonly natsUrl?: string;
  /** Owner token (3rd subject segment). Defaults to $USER. */
  readonly owner: string;
  /** Controller instance name (4th subject token for the controller). */
  readonly name: string;
  /** Default model spec for spawns that don't set one. */
  readonly defaultModel?: string;
  /** Default thinking level. */
  readonly defaultThinkingLevel?: string;
  /** Default session lifetime in seconds. */
  readonly defaultMaxLifetimeS: number;
}

const CONFIG_FILE = join(homedir(), ".pi-headless", "config.json");

const BUILT_IN_DEFAULTS = {
  name: "exec",
  defaultMaxLifetimeS: 1800,
} as const;

interface RawConfigFile {
  context?: string;
  name?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
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
    process.stderr.write(`pi-headless: failed to read ${CONFIG_FILE}: ${(e as Error).message}\n`);
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

export function loadConfig(cli: CliOverrides = {}): PiHeadlessConfig {
  const file = readConfigFile();
  const env = process.env;

  const owner =
    cli.owner ?? env["PI_HEADLESS_OWNER"] ?? env["USER"] ?? userInfo().username ?? "anon";
  const name = cli.name ?? env["PI_HEADLESS_NAME"] ?? file.name ?? BUILT_IN_DEFAULTS.name;
  const context = cli.context ?? env["NATS_CONTEXT"] ?? file.context;
  const natsUrl = cli.natsUrl ?? env["NATS_URL"];
  const defaultModel = env["PI_HEADLESS_DEFAULT_MODEL"] ?? file.defaultModel;
  const defaultThinkingLevel = env["PI_HEADLESS_DEFAULT_THINKING_LEVEL"] ?? file.defaultThinkingLevel;
  const maxLifetimeEnv = env["PI_HEADLESS_DEFAULT_MAX_LIFETIME"];
  const defaultMaxLifetimeS =
    (maxLifetimeEnv ? Number(maxLifetimeEnv) : undefined) ??
    file.defaultMaxLifetimeS ??
    BUILT_IN_DEFAULTS.defaultMaxLifetimeS;

  if (!context && !natsUrl) {
    throw new Error(
      "pi-headless: no NATS target configured. Set --context, NATS_CONTEXT, or NATS_URL.",
    );
  }

  return {
    ...(context ? { context } : {}),
    ...(natsUrl ? { natsUrl } : {}),
    owner,
    name,
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
    defaultMaxLifetimeS,
  };
}

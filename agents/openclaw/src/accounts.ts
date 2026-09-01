import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type {
  NatsAccountConfig,
  ResolvedNatsAccount,
  SenderIdentityMode,
  SenderTrustMode,
} from "./types.js";

// OpenClaw's canonical default account id. Kept local so account resolution
// and its tests remain usable when the optional host peer is not installed.
const DEFAULT_ACCOUNT_ID = "default";

function getNatsConfig(cfg: OpenClawConfig): Record<string, unknown> {
  return (
    ((cfg as Record<string, unknown>).channels as Record<string, unknown>) ?? {}
  );
}

function getNatsChannelConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const channels = getNatsConfig(cfg);
  return (
    ((channels as Record<string, unknown>).nats as Record<string, unknown>) ??
    {}
  );
}

function getAccounts(cfg: OpenClawConfig): Record<string, NatsAccountConfig> {
  const nats = getNatsChannelConfig(cfg);
  return (
    (nats as Record<string, Record<string, NatsAccountConfig>>).accounts ?? {}
  );
}

// Dedup env-override log lines so the many `currentValue` callbacks in the
// setup wizard don't flood the console — one line per (accountId, envVar) pair
// per process is enough to make the override visible. The dedup affects
// LOGGING ONLY: `applyEnvOverride` always assigns `resolved[field]` before
// the dedup check, so a missing log line never means a missing override.
const loggedEnvOverrides = new Set<string>();

function applyEnvOverride(
  resolved: ResolvedNatsAccount,
  field:
    | "url"
    | "agentName"
    | "description"
    | "owner"
    | "credentials"
    | "senderIdentity"
    | "minSenderTrust",
  configValue: string | undefined,
  envValue: string | undefined,
  accountId: string,
  envName: string,
  redact = false,
): void {
  if (envValue === undefined) return;
  (resolved as unknown as Record<string, unknown>)[field] = envValue;
  const key = `${accountId}:${envName}`;
  if (loggedEnvOverrides.has(key)) return;
  loggedEnvOverrides.add(key);
  const show = (v: string | undefined): string =>
    v === undefined || v === "" ? "<unset>" : redact ? "<redacted>" : v;
  const changed = (configValue ?? "") !== envValue;
  const suffix = changed
    ? `config=${show(configValue)} → env=${show(envValue)}`
    : `matches config (${show(envValue)})`;
  console.warn(
    `[nats] env override ${envName} (account=${accountId}): ${suffix}`,
  );
}

function resolveSenderIdentity(
  value: unknown,
  source: string,
): SenderIdentityMode {
  if (value === undefined || value === "") return "off";
  if (value === "off" || value === "signed") return value;
  throw new Error(`${source} must be "off" or "signed"`);
}

function resolveSenderTrust(value: unknown, source: string): SenderTrustMode {
  if (value === undefined || value === "") return "any";
  if (value === "any" || value === "signed") return value;
  throw new Error(`${source} must be "any" or "signed"`);
}

// First defined entry from an ordered list of env var names. Identity vars
// follow the SYNADIA_* convention shared across agents/*: per-agent var >
// fleet-wide var > legacy alias. Returns the winning name alongside the
// value so the override log can attribute it to the var that supplied it.
function firstDefinedEnv(
  ...names: string[]
): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) return { name, value };
  }
  return undefined;
}

export function listNatsAccountIds(cfg: OpenClawConfig): string[] {
  const ids = Object.keys(getAccounts(cfg));
  const result = ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
  const nameEnv = firstDefinedEnv(
    "SYNADIA_OPENCLAW_NAME",
    "SYNADIA_NAME",
    "NATS_AGENT_NAME",
  );
  console.log(
    `[nats] listAccountIds: ${JSON.stringify(result)} (config keys: ${ids.length}, name env: ${
      nameEnv ? `${nameEnv.name}=${nameEnv.value}` : "unset"
    })`,
  );
  return result;
}

export function resolveNatsAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedNatsAccount {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const accounts = getAccounts(cfg);
  const raw = accounts[id] ?? ({} as NatsAccountConfig);

  // Legacy `org` maps 1:1 to `owner`. Warn once per resolve when only the old
  // field is present so users see the migration hint in logs.
  let owner = raw.owner ?? "";
  if (!owner && raw.org) {
    owner = raw.org;
    console.warn(
      `[nats] config field 'org' is deprecated; rename to 'owner' in channels.nats.accounts.${id}`,
    );
  }

  const resolved: ResolvedNatsAccount = {
    accountId: id,
    enabled: raw.enabled !== false,
    url: raw.url ?? "",
    agentName: raw.agentName ?? "",
    description: raw.description ?? "",
    credentials: raw.credentials,
    context: raw.context,
    // Validate the final values after env overrides have been applied.
    senderIdentity: (raw.senderIdentity ?? "off") as SenderIdentityMode,
    minSenderTrust: (raw.minSenderTrust ?? "any") as SenderTrustMode,
    owner,
    config: raw,
    // Replaced below after the atomic source has been selected.
    connectionSource: { url: "nats://demo.nats.io" },
  };

  // Environment variable overrides (for Docker/container deployments).
  // A context is one atomic connection/auth source. Direct URL/credentials
  // env vars select the direct source as a unit rather than splicing values
  // into a context. $NATS_CONTEXT then wins over that direct source.
  //
  // Resolution order (matches pi-headless + agents/pi):
  //   1. $NATS_CONTEXT       — env-var NATS CLI context file (highest)
  //   2. direct env (`$NATS_URL` / `$NATS_CREDENTIALS`) plus direct config
  //   3. config.context      — when no direct env override is present
  //   4. account config (`url`, `credentials`)
  //   5. built-in default    — `demo.nats.io`
  //
  // Identity tokens (owner / agentName) follow the SYNADIA_* convention
  // shared across agents/*: per-agent var (SYNADIA_OPENCLAW_*) > fleet-wide
  // var (SYNADIA_*) > legacy alias (NATS_OWNER / NATS_ORG / NATS_AGENT_NAME)
  // > account config. The legacy vars keep working indefinitely.
  const env = process.env;

  // ── Per-field env overrides (lower precedence than $NATS_CONTEXT) ──────
  const directEnvSelected =
    env.NATS_URL !== undefined ||
    env.NATS_CREDENTIALS !== undefined ||
    env.NATS_CREDS !== undefined;
  if (directEnvSelected && resolved.context) {
    console.warn(
      `[nats] direct connection env overrides config.context atomically (account=${id})`,
    );
    resolved.context = undefined;
  }
  applyEnvOverride(
    resolved,
    "url",
    resolved.url,
    env.NATS_URL,
    id,
    "NATS_URL",
    true,
  );
  const nameEnv = firstDefinedEnv(
    "SYNADIA_OPENCLAW_NAME",
    "SYNADIA_NAME",
    "NATS_AGENT_NAME",
  );
  if (nameEnv) {
    applyEnvOverride(
      resolved,
      "agentName",
      raw.agentName,
      nameEnv.value,
      id,
      nameEnv.name,
    );
  }
  applyEnvOverride(
    resolved,
    "description",
    raw.description,
    env.NATS_DESCRIPTION,
    id,
    "NATS_DESCRIPTION",
  );
  const ownerEnv = firstDefinedEnv(
    "SYNADIA_OPENCLAW_OWNER",
    "SYNADIA_OWNER",
    "NATS_OWNER",
    "NATS_ORG",
  );
  if (ownerEnv) {
    applyEnvOverride(
      resolved,
      "owner",
      raw.owner ?? raw.org,
      ownerEnv.value,
      id,
      ownerEnv.name,
    );
  }
  // NATS_CREDENTIALS deliberately wins over the NATS_CREDS alias here —
  // it's openclaw's incumbent var, so existing deployments see zero change
  // when both are set. (flue/opencode check NATS_CREDS first; only the
  // accepted spelling is shared, not the tie-break order.)
  const credsEnv = firstDefinedEnv("NATS_CREDENTIALS", "NATS_CREDS");
  if (credsEnv) {
    applyEnvOverride(
      resolved,
      "credentials",
      resolved.credentials,
      credsEnv.value,
      id,
      credsEnv.name,
      true,
    );
  }
  applyEnvOverride(
    resolved,
    "senderIdentity",
    raw.senderIdentity,
    env.NATS_SENDER_IDENTITY,
    id,
    "NATS_SENDER_IDENTITY",
  );
  applyEnvOverride(
    resolved,
    "minSenderTrust",
    raw.minSenderTrust,
    env.NATS_MIN_SENDER_TRUST,
    id,
    "NATS_MIN_SENDER_TRUST",
  );

  // ── $NATS_CONTEXT (highest precedence) ───────────────────────────────
  // Applied LAST so it wins over $NATS_URL and $NATS_CREDENTIALS as the
  // complete source. Resolution failures are startup errors: silently
  // falling back could connect under a different identity than requested.
  if (env.NATS_CONTEXT) {
    const previous = resolved.context;
    resolved.context = env.NATS_CONTEXT;
    resolved.url = "";
    resolved.credentials = undefined;
    const changed = previous !== env.NATS_CONTEXT;
    console.warn(
      `[nats] env override NATS_CONTEXT (account=${id}): ${
        changed
          ? `config=${previous || "<unset>"} → env=${env.NATS_CONTEXT}`
          : "matches config"
      }`,
    );
  }

  resolved.senderIdentity = resolveSenderIdentity(
    resolved.senderIdentity,
    env.NATS_SENDER_IDENTITY !== undefined
      ? "NATS_SENDER_IDENTITY"
      : `channels.nats.accounts.${id}.senderIdentity`,
  );
  resolved.minSenderTrust = resolveSenderTrust(
    resolved.minSenderTrust,
    env.NATS_MIN_SENDER_TRUST !== undefined
      ? "NATS_MIN_SENDER_TRUST"
      : `channels.nats.accounts.${id}.minSenderTrust`,
  );

  if (resolved.context) {
    resolved.connectionSource = { context: resolved.context };
  } else if (resolved.credentials) {
    resolved.connectionSource = {
      url: resolved.url || "nats://demo.nats.io",
      creds: resolved.credentials,
    };
  } else {
    resolved.connectionSource = { url: resolved.url || "nats://demo.nats.io" };
  }

  // Spec §2 requires a 4-token subject. Default the owner token rather than
  // leaving it empty and producing `agents.oc..name`.
  if (!resolved.owner) resolved.owner = "default";

  return resolved;
}

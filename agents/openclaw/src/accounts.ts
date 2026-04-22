import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import type { NatsAccountConfig, ResolvedNatsAccount } from "./types.js";

function getNatsConfig(cfg: OpenClawConfig): Record<string, unknown> {
  return (cfg as Record<string, unknown>).channels as Record<string, unknown> ?? {};
}

function getNatsChannelConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const channels = getNatsConfig(cfg);
  return (channels as Record<string, unknown>).nats as Record<string, unknown> ?? {};
}

function getAccounts(cfg: OpenClawConfig): Record<string, NatsAccountConfig> {
  const nats = getNatsChannelConfig(cfg);
  return (nats as Record<string, Record<string, NatsAccountConfig>>).accounts ?? {};
}

// Dedup env-override log lines so the many `currentValue` callbacks in the
// setup wizard don't flood the console — one line per (accountId, envVar) pair
// per process is enough to make the override visible.
const loggedEnvOverrides = new Set<string>();

function applyEnvOverride(
  resolved: ResolvedNatsAccount,
  field: "url" | "agentName" | "description" | "owner" | "credentials",
  configValue: string | undefined,
  envValue: string | undefined,
  accountId: string,
  envName: string,
  redact = false,
): void {
  if (envValue === undefined) return;
  resolved[field] = envValue;
  const key = `${accountId}:${envName}`;
  if (loggedEnvOverrides.has(key)) return;
  loggedEnvOverrides.add(key);
  const show = (v: string | undefined): string =>
    v === undefined || v === "" ? "<unset>" : redact ? "<redacted>" : v;
  const changed = (configValue ?? "") !== envValue;
  const suffix = changed
    ? `config=${show(configValue)} → env=${show(envValue)}`
    : `matches config (${show(envValue)})`;
  console.warn(`[nats] env override ${envName} (account=${accountId}): ${suffix}`);
}

export function listNatsAccountIds(cfg: OpenClawConfig): string[] {
  const ids = Object.keys(getAccounts(cfg));
  const result = ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
  console.log(
    `[nats] listAccountIds: ${JSON.stringify(result)} (config keys: ${ids.length}, NATS_AGENT_NAME: ${
      process.env.NATS_AGENT_NAME ?? "unset"
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
    owner,
    config: raw,
  };

  // Environment variable overrides (for Docker/container deployments).
  const env = process.env;
  applyEnvOverride(resolved, "url", raw.url, env.NATS_URL, id, "NATS_URL");
  applyEnvOverride(resolved, "agentName", raw.agentName, env.NATS_AGENT_NAME, id, "NATS_AGENT_NAME");
  applyEnvOverride(resolved, "description", raw.description, env.NATS_DESCRIPTION, id, "NATS_DESCRIPTION");
  if (env.NATS_OWNER !== undefined) {
    applyEnvOverride(resolved, "owner", raw.owner ?? raw.org, env.NATS_OWNER, id, "NATS_OWNER");
  } else if (env.NATS_ORG !== undefined) {
    applyEnvOverride(resolved, "owner", raw.owner ?? raw.org, env.NATS_ORG, id, "NATS_ORG");
  }
  applyEnvOverride(resolved, "credentials", raw.credentials, env.NATS_CREDENTIALS, id, "NATS_CREDENTIALS", true);

  // Spec §2 requires a 4-token subject. Default the owner token rather than
  // leaving it empty and producing `agents.oc..name`.
  if (!resolved.owner) resolved.owner = "default";

  return resolved;
}

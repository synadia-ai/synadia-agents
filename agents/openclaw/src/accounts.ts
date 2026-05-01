import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import type { NatsAccountConfig, ResolvedNatsAccount } from "./types.js";
import { loadNatsContextFromFile } from "./nats/context-loader.js";

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

  // ── config.context (wizard-selected NATS CLI context) ────────────────
  // Apply BEFORE per-field env vars so a deployer's `NATS_URL` /
  // `NATS_CREDENTIALS` can still override an individual field of the
  // wizard-chosen context. `$NATS_CONTEXT` (handled below) still wins
  // over everything.
  if (raw.context) {
    try {
      const ctx = loadNatsContextFromFile(raw.context);
      resolved.url = ctx.url;
      if (ctx.credentials) resolved.credentials = ctx.credentials;
    } catch (err) {
      console.warn(
        `[nats] config.context="${raw.context}" failed to load — falling back to per-field config: ${(err as Error).message}`,
      );
    }
  }

  // Environment variable overrides (for Docker/container deployments).
  // Per-field env vars apply first; $NATS_CONTEXT is then applied LAST so
  // it acts as a single source of truth for url + credentials when set
  // (otherwise $NATS_CREDENTIALS could silently win over context creds and
  // produce a confusing url-from-context-creds-from-elsewhere split that
  // fails opaquely at connect time).
  //
  // Resolution order (matches pi-headless + agents/pi):
  //   1. $NATS_CONTEXT       — env-var NATS CLI context file (highest)
  //   2. $NATS_URL           — raw URL
  //   3. $NATS_CREDENTIALS   — overrides config creds field
  //   4. config.context      — wizard-selected NATS CLI context file
  //   5. account config (`url`, `credentials`)
  //   6. built-in default    — `demo.nats.io` (set in connection.ts)
  const env = process.env;

  // ── Per-field env overrides (lower precedence than $NATS_CONTEXT) ──────
  // Pass `resolved.*` (not `raw.*`) for url/credentials so the override
  // log reflects the actual prior value being replaced — including the
  // case where `config.context` already expanded it. Logging `raw.url` /
  // `raw.credentials` would read `<unset>` even when the prior value was
  // sourced from a context file, which misleads debugging.
  applyEnvOverride(resolved, "url", resolved.url, env.NATS_URL, id, "NATS_URL");
  applyEnvOverride(resolved, "agentName", raw.agentName, env.NATS_AGENT_NAME, id, "NATS_AGENT_NAME");
  applyEnvOverride(resolved, "description", raw.description, env.NATS_DESCRIPTION, id, "NATS_DESCRIPTION");
  if (env.NATS_OWNER !== undefined) {
    applyEnvOverride(resolved, "owner", raw.owner ?? raw.org, env.NATS_OWNER, id, "NATS_OWNER");
  } else if (env.NATS_ORG !== undefined) {
    applyEnvOverride(resolved, "owner", raw.owner ?? raw.org, env.NATS_ORG, id, "NATS_ORG");
  }
  applyEnvOverride(resolved, "credentials", resolved.credentials, env.NATS_CREDENTIALS, id, "NATS_CREDENTIALS", true);

  // ── $NATS_CONTEXT (highest precedence) ───────────────────────────────
  // Applied LAST so it wins over $NATS_URL and $NATS_CREDENTIALS — a
  // deployer who set $NATS_CONTEXT meant it as the single source of
  // truth. Failures are logged and downgraded so the gateway falls back
  // to whatever the per-field env / config resolved instead of crashing.
  if (env.NATS_CONTEXT) {
    try {
      const ctx = loadNatsContextFromFile(env.NATS_CONTEXT);
      applyEnvOverride(resolved, "url", resolved.url, ctx.url, id, "NATS_CONTEXT");
      if (ctx.credentials) {
        applyEnvOverride(
          resolved,
          "credentials",
          resolved.credentials,
          ctx.credentials,
          id,
          "NATS_CONTEXT",
          true,
        );
      }
    } catch (err) {
      console.warn(
        `[nats] $NATS_CONTEXT="${env.NATS_CONTEXT}" failed to load — falling back to NATS_URL/config: ${(err as Error).message}`,
      );
    }
  }

  // Spec §2 requires a 4-token subject. Default the owner token rather than
  // leaving it empty and producing `agents.oc..name`.
  if (!resolved.owner) resolved.owner = "default";

  return resolved;
}

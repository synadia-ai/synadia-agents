export interface NatsAccountConfig {
  url?: string;
  agentName: string;
  description?: string;
  credentials?: string;
  enabled?: boolean;
  /**
   * 3rd subject token — the "operator/account" segment. Pre-0.3 this
   * field was called `org`; the old name is still accepted with a warning for
   * smooth migration and maps straight into `owner`.
   */
  owner?: string;
  /** @deprecated Use `owner` instead. Accepted as a legacy alias. */
  org?: string;
  /**
   * Name of a `nats` CLI context (file under `~/.config/nats/context/<name>.json`)
   * to source `url` and `credentials` from. Set by the setup wizard's "context"
   * input. Mirrors `$NATS_CONTEXT` env-var support but persists in the config.
   * Per-field `url` / `credentials` and the env-var equivalents still take
   * precedence; this is the "wizard chose a context" default.
   */
  context?: string;
}

export interface ResolvedNatsAccount {
  accountId: string;
  enabled: boolean;
  url: string;
  agentName: string;
  description: string;
  credentials?: string;
  /** Resolved owner token (never empty; defaults to "default"). */
  owner: string;
  config: NatsAccountConfig;
}

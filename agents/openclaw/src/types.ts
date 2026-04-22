export interface NatsAccountConfig {
  url?: string;
  agentName: string;
  description?: string;
  credentials?: string;
  enabled?: boolean;
  /**
   * 3rd subject token (spec §2) — the "operator/account" segment. Pre-0.3 this
   * field was called `org`; the old name is still accepted with a warning for
   * smooth migration and maps straight into `owner`.
   */
  owner?: string;
  /** @deprecated Use `owner` instead. Accepted as a legacy alias. */
  org?: string;
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

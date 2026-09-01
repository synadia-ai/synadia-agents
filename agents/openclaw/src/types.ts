import type { NatsConnectionSource } from "@synadia-ai/agents";

export type SenderIdentityMode = "off" | "signed";
export type SenderTrustMode = "any" | "signed";

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
   * input. Contexts are atomic connection/auth sources: they are never mixed
   * with a URL or credentials path from another source.
   */
  context?: string;
  /** Derive a sender signer from the selected connection credentials. */
  senderIdentity?: SenderIdentityMode;
  /** Minimum trust required for incoming prompts. Independent of senderIdentity. */
  minSenderTrust?: SenderTrustMode;
}

export interface ResolvedNatsAccount {
  accountId: string;
  enabled: boolean;
  url: string;
  agentName: string;
  description: string;
  credentials?: string;
  context?: string;
  /** The one atomic connection/auth source consumed by the shared SDK helper. */
  connectionSource: NatsConnectionSource;
  senderIdentity: SenderIdentityMode;
  minSenderTrust: SenderTrustMode;
  /** Resolved owner token (never empty; defaults to "default"). */
  owner: string;
  config: NatsAccountConfig;
}

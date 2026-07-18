export type AcpMode = "fake" | "managed";
export type AcpPermissionPolicy = "reject" | "query" | "allow";

export interface NatsConfig {
  readonly url?: string;
  readonly context?: string;
  readonly creds?: string;
}

export interface AgentIdentityConfig {
  readonly owner: string;
  readonly session: string;
  readonly subjectToken: string;
  readonly heartbeatIntervalS: number;
  readonly keepaliveIntervalS: number;
}

export interface AcpRuntimeConfig {
  readonly mode: AcpMode;
  /** Preset name this config was resolved from (`grok`, `gemini`, or `custom`). */
  readonly preset: string;
  /** Canonical agent identifier advertised as `metadata.agent`. */
  readonly agentId: string;
  /** Binary spawned in `agent stdio` (ACP) mode. */
  readonly bin: string;
  readonly args: readonly string[];
  /**
   * Env var the agent reads its home/state directory from (e.g. `GROK_HOME`).
   * When set and `agentHome` is not, managed mode isolates the agent in an
   * ephemeral temp home (removed on close). Preset-defined; absent for agents
   * without a documented home env var.
   */
  readonly homeEnvVar?: string;
  /** Explicit home directory (e.g. an already-authenticated `~/.grok`). */
  readonly agentHome?: string;
  /** Working directory for the ACP session. Absolute. */
  readonly cwd: string;
  readonly permissionPolicy: AcpPermissionPolicy;
}

export interface AcpChannelConfig {
  readonly nats: NatsConfig;
  readonly agent: AgentIdentityConfig;
  readonly acp: AcpRuntimeConfig;
}

export interface AcpMapping {
  readonly owner: string;
  readonly session: string;
  readonly subjectToken: string;
  readonly acp: AcpRuntimeConfig;
}

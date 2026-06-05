export type OpenCodeMode = "managed" | "attached";
export type PermissionPolicy = "query" | "local" | "reject";

export interface NatsConfig {
  readonly url?: string;
  readonly context?: string;
  readonly creds?: string;
}

export interface AgentConfig {
  readonly owner: string;
  readonly name: string;
  readonly subjectToken: "opencode";
  readonly heartbeatIntervalS: number;
  readonly keepaliveIntervalS: number;
}

export interface OpenCodeConfig {
  readonly mode: OpenCodeMode;
  readonly baseUrl?: string;
  readonly hostname: string;
  readonly port: number;
  readonly directory?: string;
  readonly workspace?: string;
  readonly serverPassword?: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly permissionPolicy: PermissionPolicy;
  readonly permissionTimeoutMs: number;
}

export interface OpenCodeChannelConfig {
  readonly nats: NatsConfig;
  readonly agent: AgentConfig;
  readonly opencode: OpenCodeConfig;
}

export interface OpenCodeMapping {
  readonly owner: string;
  readonly name: string;
  readonly subjectToken: "opencode";
  readonly opencode: OpenCodeConfig;
}

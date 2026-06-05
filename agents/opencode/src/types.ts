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
  readonly opencodePath?: string;
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

export class OpenCodeAdapterNotImplementedError extends Error {
  constructor(message = "OpenCode runtime bridge is not implemented in the Phase 3 scaffold") {
    super(message);
    this.name = "OpenCodeAdapterNotImplementedError";
  }
}

export type CodexMode = "fake" | "managed" | "attached" | "manager";
export type CodexPermissionPolicy = "query" | "external-owner" | "reject" | "detect";

export interface NatsConfig {
  readonly url?: string;
  readonly context?: string;
  readonly creds?: string;
}

export interface AgentConfig {
  readonly owner: string;
  readonly session: string;
  readonly subjectToken: "codex";
  readonly heartbeatIntervalS: number;
  readonly keepaliveIntervalS: number;
}

export interface CodexConfig {
  readonly mode: CodexMode;
  readonly codexBin: string;
  readonly codeHome?: string;
  readonly endpoint?: string;
  readonly endpointAuth?: string;
  readonly threadId?: string;
  readonly publicAlias?: string;
  readonly permissionPolicy: CodexPermissionPolicy;
}

export interface CodexManagerConfig {
  readonly enabled: boolean;
  readonly autoExposeCurrentSessions: boolean;
  readonly autoExposeFutureSessions: boolean;
  readonly watchMode: "event-plus-poll" | "poll";
  readonly watchIntervalMs: number;
  readonly staleGraceIntervals: number;
  readonly exposeEphemeralLoadedSessions: boolean;
}

export interface CodexChannelConfig {
  readonly nats: NatsConfig;
  readonly agent: AgentConfig;
  readonly codex: CodexConfig;
  readonly manager: CodexManagerConfig;
}

export interface CodexMapping {
  readonly owner: string;
  readonly session: string;
  readonly subjectToken: "codex";
  readonly codex: CodexConfig;
  readonly manager: CodexManagerConfig;
}

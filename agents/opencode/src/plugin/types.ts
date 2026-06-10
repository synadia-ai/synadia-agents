import type { PromptResponse } from "@synadia-ai/agent-service";
import type { OpenCodeChannelConfig } from "../types.js";

export type PluginPermissionReply = "once" | "always" | "reject";

export interface OpenCodePluginContext {
  readonly client?: {
    readonly event?: { subscribe?(options?: Record<string, unknown>): Promise<{ stream: AsyncIterable<unknown> }> };
    readonly session?: {
      create?(options?: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>;
      prompt?(options: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>;
    };
    readonly permission?: {
      reply?(input: { requestID: string; reply: PluginPermissionReply; message?: string; directory?: string }): Promise<unknown> | unknown;
    };
    postSessionIdPermissionsPermissionId?(input: { path: { id: string; permissionID: string }; query?: { directory?: string }; body: { response: PluginPermissionReply } }): Promise<unknown> | unknown;
    readonly app?: { log?(input: { body: Record<string, unknown> }): Promise<unknown> | unknown };
  };
  readonly project?: Record<string, unknown>;
  readonly directory?: string;
  readonly worktree?: string;
  readonly serverUrl?: URL | string;
}

export interface PluginRuntimeOptions {
  readonly env?: Record<string, string | undefined>;
  readonly version?: string;
  readonly log?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface PluginIdentity {
  readonly owner: string;
  readonly session: string;
  readonly source: "explicit" | "hashed-directory";
  readonly directoryHash: string;
  readonly worktreeHash: string;
  readonly projectIdHash: string;
  readonly serverOrigin: string;
  readonly metadata: Record<string, string>;
}

export interface PluginChannelState {
  readonly key: string;
  readonly config: OpenCodeChannelConfig;
  readonly identity: PluginIdentity;
  readonly eventTypes: Map<string, number>;
  readonly activePrompts: Map<string, ActivePluginPrompt>;
  duplicateInitCount: number;
  disposeCount: number;
  permissionBridgeCount: number;
  promptCount: number;
  subject?: string;
}

export interface ActivePluginPrompt {
  readonly sessionId: string;
  readonly response?: PromptResponse;
  readonly queue: PluginEventQueue;
  readonly createdAt: number;
}

export interface PluginPromptEventQueueItem {
  readonly type: "status" | "response" | "permission" | "done";
  readonly text?: string;
  readonly question?: string;
  readonly timeoutMs?: number;
  decide?(reply: PluginPermissionReply): Promise<void>;
}

export interface PluginEventQueue extends AsyncIterable<PluginPromptEventQueueItem> {
  push(event: PluginPromptEventQueueItem): void;
  fail(error: unknown): void;
  close(): void;
}

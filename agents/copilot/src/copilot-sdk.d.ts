// The CLI injects the SDK (`@github/copilot-sdk` or, in some builds,
// `@microsoft/copilot-sdk`) into every extension process; it is never
// installed or bundled. These are the few shapes this extension uses
// (from the SDK's `extension.d.ts` / `session.d.ts`, CLI 1.0.x).
declare module "@github/copilot-sdk/extension" {
  export interface ExtensionSessionEvent {
    readonly type: string;
    readonly data?: unknown;
    readonly agentId?: string;
  }
  export interface ExtensionSession {
    readonly sessionId: string;
    readonly workspacePath?: string;
    send(options: { prompt: string; attachments?: Array<{ type: "file"; path: string; displayName?: string }> }): Promise<string>;
    on(handler: (event: ExtensionSessionEvent) => void): () => void;
    on(type: string, handler: (event: ExtensionSessionEvent) => void): () => void;
    log(message: string, options?: { level?: "info" | "warning" | "error"; ephemeral?: boolean }): Promise<void>;
  }
  export interface JoinSessionConfig {
    tools?: ReadonlyArray<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
      skipPermission?: boolean;
      handler: (args: unknown, invocation: { sessionId: string; toolCallId: string; toolName: string }) => unknown;
    }>;
    requestedEnvironmentVariables?: string[];
    onPermissionRequest?: (request: unknown, invocation: { sessionId: string }) => unknown;
  }
  export function joinSession(config?: JoinSessionConfig): Promise<ExtensionSession>;
}

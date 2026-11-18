/**
 * Adapters over differences between Copilot CLI builds. Kept free of the
 * SDK import (and of side effects) so it is unit-testable.
 *
 * The host injects the extension SDK under a name that differs by build, and
 * the join options changed shape with it:
 *  - "modern": `@microsoft/copilot-sdk` (standalone CLI 1.0.114+) —
 *      `tools: { definitions }`, `permissions: { onRequest }`.
 *  - "legacy": `@github/copilot-sdk` (e.g. the Copilot App's CLI 1.0.106) —
 *      `tools: [...]`, `onPermissionRequest`.
 * Passing the legacy array to a modern host silently drops every tool.
 */

export type SdkFlavor = "modern" | "legacy";

export type PermissionHandler = (request: unknown) => unknown;

/** Join options in the shape the loaded SDK expects. */
export function joinOptions<T>(
  flavor: SdkFlavor,
  options: { tools?: readonly T[]; requestedEnvironmentVariables?: string[]; onPermissionRequest?: PermissionHandler },
): Record<string, unknown> {
  const { tools, requestedEnvironmentVariables, onPermissionRequest } = options;
  const out: Record<string, unknown> = {};
  if (requestedEnvironmentVariables && requestedEnvironmentVariables.length > 0) {
    out.requestedEnvironmentVariables = requestedEnvironmentVariables;
  }
  if (flavor === "modern") {
    if (tools) out.tools = { definitions: tools };
    if (onPermissionRequest) out.permissions = { onRequest: onPermissionRequest };
  } else {
    if (tools) out.tools = tools;
    if (onPermissionRequest) out.onPermissionRequest = onPermissionRequest;
  }
  return out;
}

/**
 * Provenance for turns injected from the fleet (`MessageOptions.source`):
 * an identified agent, not the human at the keyboard.
 */
export const REMOTE_SOURCE = "agent-synadia-nats";

export interface SendOptions {
  prompt: string;
  attachments?: Array<{ type: "file"; path: string; displayName?: string }>;
}

interface Sendable {
  send(options: SendOptions): Promise<string>;
}

/**
 * The session as the runtime sees it, with `send` tagging injected prompts
 * with `source`. A host that rejects the field gets untagged sends from then
 * on (reported once through `onFallback`).
 */
export function withRemoteProvenance<S extends Sendable>(session: S, onFallback?: (error: unknown) => void): S {
  let tag = true;
  const send = async (options: SendOptions): Promise<string> => {
    if (tag) {
      try {
        return await session.send({ ...options, source: REMOTE_SOURCE } as SendOptions);
      } catch (error) {
        tag = false;
        onFallback?.(error);
      }
    }
    return session.send(options);
  };
  return new Proxy(session, {
    get(target, prop) {
      if (prop === "send") return send;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

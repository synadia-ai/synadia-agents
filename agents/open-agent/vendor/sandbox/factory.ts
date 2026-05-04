// Custom sandbox factory. Replaces upstream `packages/sandbox/factory.ts`
// so the vendored agent code (which imports `connectSandbox` /
// `SandboxState` from `@open-agents/sandbox`) can dispatch to either our
// `LocalSandbox` or the upstream Vercel sandbox without modification.
//
// Resolution path: `tsconfig.json` `paths` rewrites `@open-agents/sandbox`
// to `./vendor/sandbox/index.ts`, which re-exports symbols from this file.

import type { Sandbox, SandboxHooks } from "./interface.js";
import type { SandboxStatus } from "./types.js";
import {
  connectLocalSandbox,
  type LocalSandboxState,
} from "./local.js";

export type { SandboxStatus };

/**
 * Discriminated sandbox state. The bridge ships only `local`. The Vercel
 * branch is left in the type so the vendored agent code's `isSandboxState`
 * type guard keeps working — callers that need a real Vercel sandbox bring
 * their own `connectSandbox` (see `examples/open-agent-vercel`).
 */
export type SandboxState = LocalSandboxState | { type: "vercel"; [key: string]: unknown };

export interface ConnectOptions {
  env?: Record<string, string>;
  githubToken?: string;
  gitUser?: { name: string; email: string };
  hooks?: SandboxHooks;
  timeout?: number;
  ports?: number[];
  baseSnapshotId?: string;
  resume?: boolean;
  createIfMissing?: boolean;
  persistent?: boolean;
  snapshotExpiration?: number;
  skipGitWorkspaceBootstrap?: boolean;
}

export type SandboxConnectConfig = {
  state: SandboxState;
  options?: ConnectOptions;
};

/**
 * Resolve a `SandboxState` (or new-API `{state, options}`) to a connected
 * `Sandbox`. The vendored agent's tools call this on every invocation.
 */
export async function connectSandbox(
  configOrState: SandboxConnectConfig | SandboxState,
  _legacyOptions?: ConnectOptions,
): Promise<Sandbox> {
  const state = isConnectConfig(configOrState) ? configOrState.state : configOrState;

  if (state.type === "local") {
    return connectLocalSandbox(state);
  }

  if (state.type === "vercel") {
    throw new Error(
      "connectSandbox: Vercel sandbox state is not supported by @synadia-ai/open-agent. " +
        "Use the examples/open-agent-vercel package, which provides its own connectSandbox " +
        "wired to @vercel/sandbox.",
    );
  }

  // Forward-compat: unknown discriminator.
  throw new Error(
    `connectSandbox: unknown sandbox state type ${JSON.stringify((state as { type?: unknown }).type)}`,
  );
}

function isConnectConfig(value: unknown): value is SandboxConnectConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    typeof (value as { state?: unknown }).state === "object" &&
    (value as { state: { type?: unknown } }).state !== null &&
    "type" in (value as { state: { type?: unknown } }).state
  );
}

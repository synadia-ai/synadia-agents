import type { NatsConnection } from "@nats-io/nats-core";
import type { AnyAgentTool, PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

export type NatsRuntime = PluginRuntime;

export const {
  setRuntime: setNatsRuntime,
  clearRuntime: clearNatsRuntime,
  getRuntime: getNatsRuntime,
} = createPluginRuntimeStore<NatsRuntime>("NATS runtime not initialized");

// Active connection state — set by the gateway when it starts, read by the
// outbound `sendText` path in channel.ts. A module-level singleton because
// only one gateway instance runs at a time.
let activeNc: NatsConnection | null = null;
let activeAgentName: string | null = null;
let activeOwner: string | null = null;

export function setActiveConnection(
  nc: NatsConnection | null,
  agentName: string | null,
  owner: string | null,
): void {
  activeNc = nc;
  activeAgentName = agentName;
  activeOwner = owner;
}

export function getActiveConnection(): NatsConnection | null {
  return activeNc;
}

export function getActiveAgentName(): string | null {
  return activeAgentName;
}

export function getActiveOwner(): string | null {
  return activeOwner;
}

// The agent tools the active gateway registered, as OpenClaw tools. The
// plugin API's tool factory (`index.ts`) hands them to every turn's tool
// list; `null` until the gateway is on the bus, and again after it stops,
// so a turn served meanwhile sees no agent tool.
let activeAgentTools: AnyAgentTool[] | null = null;

export function setActiveAgentTools(tools: AnyAgentTool[] | null): void {
  activeAgentTools = tools;
}

export function getActiveAgentTools(): AnyAgentTool[] | null {
  return activeAgentTools;
}

/** The extensions the running gateway loaded, for the account they belong to. */
export interface ActiveExtensions {
  readonly accountId: string;
  /** The extensions' names, in load order. */
  readonly names: ReadonlyArray<string>;
}

// For the channel's account description; `null` while no gateway runs.
let activeExtensions: ActiveExtensions | null = null;

export function setActiveExtensions(state: ActiveExtensions | null): void {
  activeExtensions = state;
}

export function getActiveExtensions(): ActiveExtensions | null {
  return activeExtensions;
}

import type { NatsConnection } from "@nats-io/nats-core";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
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

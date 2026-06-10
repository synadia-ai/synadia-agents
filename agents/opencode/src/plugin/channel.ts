import { connect as natsConnect } from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agent-service";
import { bridgePromptToOpenCode } from "../bridge.js";
import { resolveNatsOptions } from "../nats.js";
import { buildAgentServiceOptions } from "../service.js";
import { resolvePluginConfig } from "./config.js";
import { PluginOpenCodeBridgeClient } from "./prompt.js";
import type { OpenCodePluginContext, PluginChannelState, PluginRuntimeOptions } from "./types.js";

export interface CreatedPluginChannel {
  readonly state: PluginChannelState;
  readonly hooks: {
    readonly event: (input: { event: unknown }) => Promise<void>;
    readonly dispose: () => Promise<void>;
  };
  readonly duplicate: boolean;
}

interface ChannelInstance extends CreatedPluginChannel {
  readonly stop: () => Promise<void>;
}

const channels = new Map<string, ChannelInstance>();

export async function createSynadiaPluginChannel(
  ctx: OpenCodePluginContext,
  options: PluginRuntimeOptions = {},
): Promise<CreatedPluginChannel> {
  const resolved = resolvePluginConfig(ctx, options.env);
  const key = channelKey(resolved.config.nats.url ?? resolved.config.nats.context ?? "local", resolved.identity.owner, resolved.identity.session, resolved.identity.directoryHash, resolved.identity.worktreeHash);
  const existing = channels.get(key);
  if (existing) {
    existing.state.duplicateInitCount += 1;
    options.log?.("duplicate OpenCode Synadia plugin init reused existing channel", { key, subject: existing.state.subject, duplicateInitCount: existing.state.duplicateInitCount });
    return {
      state: existing.state,
      duplicate: true,
      hooks: {
        event: async () => undefined,
        dispose: async () => options.log?.("duplicate OpenCode Synadia plugin dispose ignored", { key }),
      },
    };
  }

  const state: PluginChannelState = {
    key,
    config: resolved.config,
    identity: resolved.identity,
    eventTypes: new Map(),
    activePrompts: new Map(),
    duplicateInitCount: 0,
    disposeCount: 0,
    permissionBridgeCount: 0,
    promptCount: 0,
  };
  const bridgeClient = new PluginOpenCodeBridgeClient(ctx, state);
  const nc = await natsConnect(await resolveNatsOptions(resolved.config.nats));
  const service = new AgentService(buildAgentServiceOptions({
    nc,
    config: resolved.config,
    version: options.version ?? "0.0.0",
    extraMetadata: resolved.identity.metadata,
  }));
  service.onPrompt(async (envelope, response) => {
    await bridgePromptToOpenCode({ envelope, response, mapping: { owner: resolved.identity.owner, name: resolved.identity.session, subjectToken: "opencode", opencode: resolved.config.opencode }, client: bridgeClient });
  });
  await service.start();
  state.subject = service.subject.prompt;

  let disposed = false;
  const stop = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    state.disposeCount += 1;
    channels.delete(key);
    await service.stop();
    await nc.drain();
  };
  const instance: ChannelInstance = {
    state,
    duplicate: false,
    stop,
    hooks: {
      event: async ({ event }) => {
        try {
          await bridgeClient.handleEvent(event);
        } catch (err) {
          options.log?.("OpenCode Synadia plugin event handling failed", { error: err instanceof Error ? err.message : String(err) });
        }
      },
      dispose: stop,
    },
  };
  channels.set(key, instance);
  options.log?.("OpenCode Synadia plugin channel started", { subject: state.subject, owner: resolved.identity.owner, session: resolved.identity.session });
  return instance;
}

export function activeSynadiaPluginChannelCount(): number {
  return channels.size;
}

export async function stopAllSynadiaPluginChannels(): Promise<void> {
  await Promise.all([...channels.values()].map((channel) => channel.stop()));
}

function channelKey(natsTarget: string, owner: string, session: string, directoryHash: string, worktreeHash: string): string {
  return [natsTarget, owner, session, directoryHash, worktreeHash].join(":");
}

import pkg from "../../package.json" assert { type: "json" };
import { createSynadiaPluginChannel } from "./channel.js";
import type { OpenCodePluginContext } from "./types.js";

export { activeSynadiaPluginChannelCount, createSynadiaPluginChannel, stopAllSynadiaPluginChannels } from "./channel.js";
export { resolvePluginConfig } from "./config.js";
export { derivePluginIdentity } from "./identity.js";
export { PluginOpenCodeBridgeClient, summarizePluginEvent } from "./prompt.js";
export type { OpenCodePluginContext, PluginChannelState, PluginRuntimeOptions } from "./types.js";

export async function SynadiaChannelPlugin(ctx: OpenCodePluginContext) {
  const channel = await createSynadiaPluginChannel(ctx, { version: pkg.version });
  return channel.hooks;
}

export default SynadiaChannelPlugin;

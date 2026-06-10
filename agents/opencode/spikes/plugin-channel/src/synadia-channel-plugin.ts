import { createSynadiaChannel, type SynadiaPluginContext } from "./synadia-channel-core.ts";

export const SynadiaChannelPlugin = async (ctx: SynadiaPluginContext) => {
  const channel = await createSynadiaChannel(ctx);
  return channel.hooks;
};

import { createSynadiaChannel, type SynadiaPluginContext } from "./synadia-channel-core.ts";

export const SynadiaChannelPlugin = async (ctx: SynadiaPluginContext) => {
  const channel = await createSynadiaChannel(ctx);
  return {
    ...channel.hooks,
    tool: {
      synadia_permission_probe: {
        description: "Deterministic Synadia permission bridge probe tool. Calls OpenCode's real tool permission ask path.",
        args: {},
        execute: async (_args: Record<string, unknown>, toolCtx: {
          sessionID: string;
          ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }): Promise<void>;
        }) => {
          await toolCtx.ask({
            permission: "bash",
            patterns: ["synadia-permission-probe *"],
            always: [],
            metadata: { source: "synadia_permission_probe", deterministic: true },
          });
          return "synadia permission probe tool completed after permission reply";
        },
      },
    },
  };
};

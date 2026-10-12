import type {
  ChannelPlugin,
  OpenClawPluginApi,
  PluginRuntime,
} from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { AGENT_TOOL_NAMES } from "@synadia-ai/agents";
import { createNatsConfigBootstrap } from "./src/bootstrap.js";
import { natsPlugin } from "./src/channel.js";
import { getActiveAgentTools, setNatsRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "nats",
  name: "NATS",
  description: "NATS agent connectivity channel plugin",
  plugin: natsPlugin as ChannelPlugin,
  setRuntime: (runtime: PluginRuntime) => {
    setNatsRuntime(runtime);
    // Fires in "discovery" mode (openclaw's load mode for npm-installed
    // channel plugins that aren't yet in `cfg.channels.<id>`). Without this,
    // a fresh install never bootstraps `channels.nats.accounts.default = {}`,
    // so the gateway never iterates the channel. Skipped when the environment
    // names the agent or nothing does (see src/bootstrap.ts). registerFull
    // below is a belt-and-suspenders for the full-mode path used by
    // bundled/catalog-known plugins.
    ensureNatsChannelConfig(runtime);
  },
  registerFull(api: OpenClawPluginApi) {
    ensureNatsChannelConfig(api.runtime);
    // The agent tools of the running gateway (see `src/tools.ts`). OpenClaw
    // calls the factory when it assembles a turn's tool list, so the tools
    // appear once the gateway is on the bus and go when it stops. Every
    // name the six can have is declared in `openclaw.plugin.json`'s
    // `contracts.tools`; `optional` because the account's `agentTools`
    // setting offers a subset, or none.
    api.registerTool(() => getActiveAgentTools() ?? [], {
      names: [...AGENT_TOOL_NAMES],
      optional: true,
    });
  },
});

const ensureNatsChannelConfig = createNatsConfigBootstrap();

export { natsPlugin } from "./src/channel.js";
export { setNatsRuntime } from "./src/runtime.js";

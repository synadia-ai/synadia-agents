import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { natsPlugin } from "./src/channel.js";
import { setNatsRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "nats",
  name: "NATS",
  description: "NATS agent connectivity channel plugin",
  plugin: natsPlugin as ChannelPlugin,
  setRuntime: setNatsRuntime,
  registerFull(api: OpenClawPluginApi) {
    ensureNatsChannelConfig(api);
  },
});

/** Ensure channels.nats.accounts.default exists so the gateway starts the channel. */
function ensureNatsChannelConfig(api: OpenClawPluginApi): void {
  try {
    const cfg = api.runtime.config.loadConfig() as Record<string, unknown>;
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const nats = (channels.nats ?? {}) as Record<string, unknown>;
    const accounts = (nats.accounts ?? {}) as Record<string, unknown>;

    if (channels.nats && accounts.default !== undefined) return; // already set

    // Write skeleton so the gateway discovers this channel
    accounts.default = accounts.default ?? {};
    nats.accounts = accounts;
    channels.nats = nats;
    cfg.channels = channels;
    api.runtime.config.writeConfigFile(cfg as Record<string, unknown>);
    api.logger.info?.("nats: created default channel config entry");
  } catch (err) {
    api.logger.warn?.(`nats: could not ensure channel config: ${err}`);
  }
}

export { natsPlugin } from "./src/channel.js";
export { setNatsRuntime } from "./src/runtime.js";

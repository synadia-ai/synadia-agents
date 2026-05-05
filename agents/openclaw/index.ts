import type { ChannelPlugin, OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { natsPlugin } from "./src/channel.js";
import { setNatsRuntime } from "./src/runtime.js";

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
    // so the gateway never iterates the channel and env-var-only quickstart
    // breaks. registerFull below is a belt-and-suspenders for the full-mode
    // path used by bundled/catalog-known plugins.
    ensureNatsChannelConfig(runtime);
  },
  registerFull(api: OpenClawPluginApi) {
    ensureNatsChannelConfig(api.runtime);
  },
});

// In "full" mode openclaw fires both setRuntime AND registerFull. The
// writeConfigFile is async, so without this guard both callbacks pass the
// idempotency check before the first write lands and we double-log
// "created default channel config entry" on a single gateway start.
let bootstrapAttempted = false;

/** Ensure channels.nats.accounts.default exists so the gateway starts the channel. */
function ensureNatsChannelConfig(runtime: PluginRuntime): void {
  if (bootstrapAttempted) return;
  try {
    const cfg = runtime.config.loadConfig() as Record<string, unknown>;
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const nats = (channels.nats ?? {}) as Record<string, unknown>;
    const accounts = (nats.accounts ?? {}) as Record<string, unknown>;

    if (channels.nats && accounts.default !== undefined) {
      bootstrapAttempted = true; // nothing to do, but don't re-check the cfg
      return;
    }

    // Write skeleton so the gateway discovers this channel
    accounts.default = accounts.default ?? {};
    nats.accounts = accounts;
    channels.nats = nats;
    cfg.channels = channels;
    bootstrapAttempted = true;
    Promise.resolve(runtime.config.writeConfigFile(cfg as Record<string, unknown>))
      .then(() => console.log("[nats] created default channel config entry"))
      .catch((err) => console.warn(`[nats] could not persist channel config skeleton: ${err}`));
  } catch (err) {
    console.warn(`[nats] could not ensure channel config: ${err}`);
  }
}

export { natsPlugin } from "./src/channel.js";
export { setNatsRuntime } from "./src/runtime.js";

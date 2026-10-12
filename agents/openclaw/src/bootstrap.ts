import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { envAgentName } from "./accounts.js";

/**
 * Returns the function that ensures channels.nats.accounts.default exists so
 * the gateway starts the channel. It runs once the config could be read: in
 * "full" mode openclaw fires both setRuntime AND registerFull, and the config
 * write is async, so without the guard both callbacks pass the idempotency
 * check before the first write lands and we double-log "created default
 * channel config entry". A first call that cannot read the config leaves the
 * second its retry.
 */
export function createNatsConfigBootstrap(): (runtime: PluginRuntime) => void {
  let attempted = false;
  return (runtime) => {
    if (attempted) return;
    attempted = ensureNatsChannelConfig(runtime);
  };
}

/** Returns whether the config was read, which settles the bootstrap. */
function ensureNatsChannelConfig(runtime: PluginRuntime): boolean {
  try {
    // OpenClaw 2026.8 replaced direct load/write methods with current/mutate.
    // Use the new focused mutation API when present and retain the legacy path
    // for the older supported host releases.
    const configApi = runtime.config as unknown as CompatConfigApi;
    const cfg = (configApi.current?.() ?? configApi.loadConfig?.()) as
      Record<string, unknown> | undefined;
    if (!cfg) throw new Error("OpenClaw config API is unavailable");
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const nats = (channels.nats ?? {}) as Record<string, unknown>;
    const accounts = (nats.accounts ?? {}) as Record<string, unknown>;

    if (channels.nats && accounts.default !== undefined) return true;

    // The account schema requires agentName, so the empty skeleton fails
    // validation. When the environment names the agent, the channel starts
    // from the environment and the skeleton is not needed: write nothing.
    const nameEnv = envAgentName();
    if (nameEnv?.value) {
      console.log(
        `[nats] agent name from ${nameEnv.name}; no channel config entry needed`,
      );
      return true;
    }

    // With no name anywhere the skeleton cannot pass the schema either, and
    // the channel cannot start until a name is set: say where it comes from.
    const configNamed = Object.values(accounts).some(
      (account) =>
        typeof (account as { agentName?: unknown } | null)?.agentName === "string" &&
        (account as { agentName: string }).agentName !== "",
    );
    if (!configNamed) {
      console.log(
        "[nats] agent name not set yet: it comes from SYNADIA_OPENCLAW_NAME, or channels.nats.accounts.default.agentName",
      );
      return true;
    }

    const write = configApi.mutateConfigFile
      ? configApi.mutateConfigFile({
          afterWrite: { mode: "auto" },
          mutate: (draft) => applyNatsChannelSkeleton(draft),
        })
      : configApi.writeConfigFile
        ? configApi.writeConfigFile(applyNatsChannelSkeleton(cfg))
        : Promise.reject(new Error("OpenClaw config write API is unavailable"));
    Promise.resolve(write)
      .then(() => console.log("[nats] created default channel config entry"))
      .catch((err) =>
        console.warn(
          `[nats] could not persist channel config skeleton: ${err}`,
        ),
      );
    return true;
  } catch (err) {
    console.warn(`[nats] could not ensure channel config: ${err}`);
    return false;
  }
}

interface CompatConfigApi {
  current?: () => unknown;
  loadConfig?: () => unknown;
  mutateConfigFile?: (params: {
    afterWrite: { mode: "auto" };
    mutate: (draft: Record<string, unknown>) => void;
  }) => Promise<unknown>;
  writeConfigFile?: (cfg: Record<string, unknown>) => Promise<unknown>;
}

function applyNatsChannelSkeleton(
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const nats = (channels.nats ?? {}) as Record<string, unknown>;
  const accounts = (nats.accounts ?? {}) as Record<string, unknown>;
  accounts.default ??= {};
  nats.accounts = accounts;
  channels.nats = nats;
  cfg.channels = channels;
  return cfg;
}

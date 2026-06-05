import type { OpenCodeChannelConfig } from "./config.js";
import type { OpenCodeBridgeClient } from "./bridge.js";
import { OpenCodeAdapterNotImplementedError } from "./types.js";

export interface OpenCodeClientFactoryDeps {
  readonly startManagedServer?: (config: OpenCodeChannelConfig) => Promise<unknown>;
  readonly attachToServer?: (config: OpenCodeChannelConfig) => Promise<unknown>;
}

export async function createOpenCodeClient(config: OpenCodeChannelConfig, deps: OpenCodeClientFactoryDeps = {}): Promise<OpenCodeBridgeClient> {
  if (config.opencode.mode === "attached") {
    await deps.attachToServer?.(config);
    return unimplementedClient("attached");
  }
  await deps.startManagedServer?.(config);
  return unimplementedClient("managed");
}

function unimplementedClient(mode: "managed" | "attached"): OpenCodeBridgeClient {
  return {
    mode,
    async *prompt() {
      throw new OpenCodeAdapterNotImplementedError();
    },
    async close() {
      // No owned resources in Phase 3. Phase 4 must wire managed shutdown.
    },
  };
}

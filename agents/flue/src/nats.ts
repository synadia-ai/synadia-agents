import { loadContextOptions, parseNatsUrl, withAgentReconnectDefaults } from "@synadia-ai/agents";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import type { NatsConfig } from "./config.js";

export async function resolveNatsOptions(config: NatsConfig): Promise<NodeConnectionOptions> {
  const base = config.context
    ? await loadContextOptions(config.context)
    : parseNatsUrl(config.url ?? "nats://127.0.0.1:4222");
  return withAgentReconnectDefaults(base);
}

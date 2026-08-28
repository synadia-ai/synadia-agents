import { readFileSync } from "node:fs";
import { credsAuthenticator } from "@nats-io/nats-core";
import { loadContextOptions, parseNatsUrl, withAgentReconnectDefaults } from "@synadia-ai/agents";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import type { NatsConfig } from "./config.js";

export async function resolveNatsOptions(config: NatsConfig): Promise<NodeConnectionOptions> {
  const base = config.context
    ? await loadContextOptions(config.context)
    : parseNatsUrl(config.url ?? "nats://127.0.0.1:4222");

  if (!config.context && config.creds) {
    base.authenticator = credsAuthenticator(readFileSync(config.creds));
  }

  return withAgentReconnectDefaults(base);
}

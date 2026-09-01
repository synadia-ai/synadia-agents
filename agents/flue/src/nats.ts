import {
  resolveNatsConnectionBundle,
  withAgentReconnectDefaults,
  type NatsConnectionBundle,
  type NatsConnectionSource,
} from "@synadia-ai/agents";
import type { NatsConfig } from "./config.js";

export async function resolveNatsBundle(config: NatsConfig): Promise<NatsConnectionBundle> {
  const source: NatsConnectionSource = config.context
    ? { context: config.context }
    : { url: config.url ?? "nats://127.0.0.1:4222", ...(config.creds ? { creds: config.creds } : {}) };
  const bundle = config.senderIdentity === "signed"
    ? await resolveNatsConnectionBundle(source, { identity: "signed" })
    : await resolveNatsConnectionBundle(source);
  Object.assign(bundle.connectionOptions, withAgentReconnectDefaults(bundle.connectionOptions));
  return bundle;
}

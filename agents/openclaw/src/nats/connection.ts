import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import type { ConnectionConfig } from "./types.js";

export async function connectToNats(
  config: ConnectionConfig = {},
): Promise<NatsConnection> {
  const url = config.url ?? "nats://localhost:4222";
  const nc = await connect({
    servers: url,
    name: config.name,
  });

  // Log connection status events
  (async () => {
    for await (const s of nc.status()) {
      switch (s.type) {
        case "reconnect":
          console.error(`[nats] reconnected to ${(s as unknown as Record<string, unknown>).data}`);
          break;
        case "disconnect":
          console.error(`[nats] disconnected`);
          break;
        case "error":
          console.error(`[nats] error:`, (s as unknown as Record<string, unknown>).data);
          break;
        case "update":
          console.error(`[nats] cluster update`);
          break;
      }
    }
  })().catch(() => {});

  console.error(`[nats] connected to ${url}`);
  return nc;
}

export async function drainConnection(nc: NatsConnection): Promise<void> {
  try {
    await nc.drain();
    console.error("[nats] connection drained");
  } catch (err) {
    console.error("[nats] drain error:", err);
  }
}

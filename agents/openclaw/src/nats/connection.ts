import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import type { ConnectionConfig } from "./types.js";
import { parseNatsUrl } from "./url.js";

export async function connectToNats(
  config: ConnectionConfig = {},
): Promise<NatsConnection> {
  // Default `demo.nats.io` matches agents/pi and agents/claude-code so
  // every agent in this repo lands on the same broker out of the box.
  // `||` (not `??`) so an empty-string `config.url` — which
  // `resolveNatsAccount` produces when no url source is configured —
  // also falls through to the default.
  const url = config.url || "demo.nats.io";
  // `parseNatsUrl` extracts userinfo (token / user:password) — without it
  // a URL like `nats://TOKEN@host:port` would silently drop the token,
  // because `@nats-io/transport-node`'s `connect({ servers: url })` does
  // not parse credentials from URLs.
  const nc = await connect({
    ...parseNatsUrl(url),
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

import { connect } from "@nats-io/transport-node";
import { credsAuthenticator, type NatsConnection } from "@nats-io/nats-core";
import { parseNatsUrl, withAgentReconnectDefaults } from "@synadia-ai/agents";
import { readFileSync } from "node:fs";
import type { ConnectionConfig } from "./types.js";

export async function connectToNats(config: ConnectionConfig = {}): Promise<NatsConnection> {
  // Default `demo.nats.io` matches agents/pi and agents/claude-code so
  // every agent in this repo lands on the same broker out of the box.
  // `||` (not `??`) so an empty-string `config.url` — which
  // `resolveNatsAccount` produces when no url source is configured —
  // also falls through to the default.
  const url = config.url || "demo.nats.io";
  // SDK `parseNatsUrl` extracts userinfo (token / user:password) — without
  // it a URL like `nats://TOKEN@host:port` would silently drop the token,
  // because `@nats-io/transport-node`'s `connect({ servers: url })` does
  // not parse credentials from URLs.
  const opts: Parameters<typeof connect>[0] = {
    ...parseNatsUrl(url),
    name: config.name,
  };
  // Wire NKEY/JWT auth from a `.creds` file when configured. Required for
  // NGS (Synadia Cloud) and any account-mode NATS server. `readFileSync`
  // is intentional: the connection is async but the creds file is small
  // and read once at startup, and `credsAuthenticator` wants the bytes
  // synchronously to derive the seed/JWT pair.
  if (config.credentials) {
    opts.authenticator = credsAuthenticator(readFileSync(config.credentials));
  }
  const nc = await connect(withAgentReconnectDefaults(opts));

  // Log connection status events
  (async () => {
    for await (const s of nc.status()) {
      switch (s.type) {
        case "reconnect":
          console.error(`[nats] reconnected to ${s.server}`);
          break;
        case "disconnect":
          console.error(`[nats] disconnected from ${s.server} — retrying…`);
          break;
        case "error":
          console.error(`[nats] error:`, s.error.message);
          break;
        case "update":
          console.error(`[nats] cluster update`);
          break;
        case "close":
          // Terminal — nats.js has stopped reconnecting.
          // `withAgentReconnectDefaults` sets `maxReconnectAttempts: -1`,
          // so this generally means a fatal auth error.
          console.error("[nats] connection closed — agent is off-bus until restart");
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

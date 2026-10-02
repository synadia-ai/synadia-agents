import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import {
  resolveNatsConnectionBundle,
  withAgentReconnectDefaults,
  type NatsConnectionBundle,
} from "@synadia-ai/agents";
import type { ConnectionConfig } from "./types.js";

// Connections we initiated a drain on. The status loop checks membership
// before logging the terminal `close` warning — drain emits `close` too,
// and the operator already knows they asked to exit.
const shuttingDownConnections = new WeakSet<NatsConnection>();

export interface ConnectedNats {
  readonly nc: NatsConnection;
  /** Retains reconnect/signing bytes until the connection has closed. */
  readonly bundle: NatsConnectionBundle;
}

export async function connectToNats(
  config: ConnectionConfig,
): Promise<ConnectedNats> {
  // This helper is the only credential seam: it captures the selected
  // context/creds once, derives connection auth and (when requested) the
  // signer from that same snapshot, and owns cleanup of sensitive bytes.
  const bundle = await resolveNatsConnectionBundle(config.source, {
    identity: config.senderIdentity,
  });
  let nc: NatsConnection;
  try {
    nc = await connect(
      withAgentReconnectDefaults({
        ...bundle.connectionOptions,
        name: config.name,
      }),
    );
  } catch (error) {
    // No reconnect can use the snapshot when connect() failed.
    bundle.wipe();
    throw error;
  }

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
          // so this generally means a fatal auth error. Skip the warning
          // if we initiated the drain — the operator already knows.
          if (shuttingDownConnections.has(nc)) break;
          console.error(
            "[nats] connection closed — agent is off-bus until restart",
          );
          break;
      }
    }
  })().catch(() => {});

  const sourceLabel =
    "context" in config.source
      ? `context ${JSON.stringify(config.source.context)}`
      : "configured URL";
  console.error(`[nats] connected using ${sourceLabel}`);
  return { nc, bundle };
}

export async function drainConnection(nc: NatsConnection): Promise<void> {
  shuttingDownConnections.add(nc);
  try {
    await nc.drain();
    console.error("[nats] connection drained");
  } catch (err) {
    console.error("[nats] drain error:", err);
    // The connection bundle may only wipe its retained auth snapshot after
    // reconnect is impossible. Force a close when graceful drain fails so the
    // caller can safely wipe immediately after this function returns.
    try {
      await nc.close();
      console.error("[nats] connection closed after drain error");
    } catch (closeErr) {
      console.error("[nats] close after drain error:", closeErr);
      throw closeErr;
    }
  }
}

// pi-headless entry point.
//
// Loads config, connects to NATS (via `nats context` when available),
// starts the PiSessionManager and Controller, and wires graceful
// shutdown on SIGINT/SIGTERM.

import process from "node:process";

import type { NatsConnection } from "@nats-io/nats-core";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import { connect as natsConnect } from "@nats-io/transport-node";
import { loadContextOptions, parseNatsUrl, withAgentReconnectDefaults } from "@synadia-ai/agents";

import { Controller } from "./controller.js";
import { loadConfig, parseCliOverrides } from "./config.js";
import { PiSessionManager } from "./pi-session-manager.js";
import { resolveControllerName } from "./subjects.js";

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function resolveNatsOptions(
  context: string | undefined,
  natsUrl: string | undefined,
): Promise<NodeConnectionOptions> {
  if (context) {
    return { ...(await loadContextOptions(context)), name: "pi-headless" };
  }
  if (natsUrl) {
    // `parseNatsUrl` extracts userinfo (token / user:password) — without it
    // a URL like `nats://TOKEN@host:port` would silently drop the token
    // because `@nats-io/transport-node` doesn't parse credentials from URLs.
    return { ...parseNatsUrl(natsUrl), name: "pi-headless" };
  }

  throw new Error("no NATS target configured (context / NATS_URL / --url)");
}

async function main(): Promise<void> {
  const cli = parseCliOverrides(process.argv.slice(2));
  const config = loadConfig(cli);

  const connOpts = await resolveNatsOptions(config.context, config.natsUrl);
  log(
    `pi-headless: connecting (${config.context ? `context=${config.context}` : `url=${config.natsUrl}`})`,
  );
  const nc: NatsConnection = await natsConnect(withAgentReconnectDefaults(connOpts));
  log(`pi-headless: connected`);

  const manager = new PiSessionManager({
    nc,
    owner: config.owner,
    defaultModel: config.defaultModel,
    defaultThinkingLevel: config.defaultThinkingLevel,
    defaultMaxLifetimeS: config.defaultMaxLifetimeS,
  });
  await manager.start();

  // Probe for an unclaimed controller name. With the default `control`,
  // a second pi-headless on the same NATS lands on `control-2`, a third
  // on `control-3`, and so on.
  const resolvedName = await resolveControllerName(nc, config.name, config.owner);
  if (resolvedName !== config.name) {
    log(`pi-headless: name "${config.name}" is taken; using "${resolvedName}"`);
  }

  const controller = new Controller({
    nc,
    owner: config.owner,
    name: resolvedName,
    manager,
  });
  await controller.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true; // also gates the `close`-status notification below
    log(`pi-headless: received ${signal}, shutting down (${manager.count()} sessions)`);
    // Force-exit guard — NATS close can occasionally hang.
    const forceTimer = setTimeout(() => {
      log("pi-headless: forced exit");
      process.exit(1);
    }, 5_000);
    forceTimer.unref?.();
    try {
      await controller.stop();
    } catch (e) {
      log(`pi-headless: controller.stop error: ${(e as Error).message}`);
    }
    try {
      await manager.stop();
    } catch (e) {
      log(`pi-headless: manager.stop error: ${(e as Error).message}`);
    }
    try {
      await nc.drain();
    } catch {
      /* noop */
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (err) => {
    log(`pi-headless: unhandledRejection: ${err}`);
  });
  process.on("uncaughtException", (err) => {
    log(`pi-headless: uncaughtException: ${err}`);
  });

  // Background: NATS connection status logging.
  void (async () => {
    try {
      for await (const s of nc.status()) {
        if (s.type === "disconnect") log(`pi-headless: NATS disconnected from ${s.server} — retrying…`);
        else if (s.type === "reconnect") log(`pi-headless: NATS reconnected to ${s.server}`);
        else if (s.type === "error") log(`pi-headless: NATS error: ${s.error.message}`);
        // Terminal — nats.js has stopped reconnecting.
        // `withAgentReconnectDefaults` sets `maxReconnectAttempts: -1`,
        // so this generally means a fatal auth error. During our own
        // shutdown `drain()` also emits `close`; skip the warning then.
        else if (s.type === "close" && !shuttingDown)
          log("pi-headless: NATS connection closed — agent is off-bus until restart");
      }
    } catch {
      /* status iterator ended */
    }
  })();
}

main().catch((err) => {
  log(`pi-headless: fatal: ${(err as Error).message}`);
  process.exit(1);
});

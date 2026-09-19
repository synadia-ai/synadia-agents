// pi-headless entry point.
//
// Loads config, connects to NATS (via `nats context` when available),
// starts the PiSessionManager and Controller, and wires graceful
// shutdown on SIGINT/SIGTERM.

import process from "node:process";

import type { NatsConnection } from "@nats-io/nats-core";
import { connect as natsConnect } from "@nats-io/transport-node";
import {
  resolveNatsConnectionBundle,
  withAgentReconnectDefaults,
  type NatsConnectionBundle,
} from "@synadia-ai/agents";

import { Controller } from "./controller.js";
import {
  loadConfig,
  natsConnectionSource,
  parseCliOverrides,
} from "./config.js";
import { PiSessionManager } from "./pi-session-manager.js";
import { resolveControllerName } from "./subjects.js";

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const HELP_TEXT = `Usage: nats-pi-headless [options]

Options:
  --context <name>  NATS context
  --url <url>       NATS server URL
  --owner <token>   agent owner token
  --name <token>    controller name
  -h, --help        show this help
`;

async function main(): Promise<void> {
  const cli = parseCliOverrides(process.argv.slice(2));
  if (cli.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const config = loadConfig(cli);

  // This is the only credential read. The bundle retains one snapshot for
  // reconnect authentication and, when requested, derives the signer used by
  // the controller and every logical session from that exact same snapshot.
  let bundle: NatsConnectionBundle | undefined;
  try {
    bundle = await resolveNatsConnectionBundle(
      natsConnectionSource(config.context, config.natsUrl),
      { identity: config.senderIdentity },
    );
  } catch (e) {
    throw new Error(`connection configuration failed: ${(e as Error).message}`);
  }
  log(
    `pi-headless: connecting (${config.context ? `context=${config.context}` : `url=${config.natsUrl}`}, sender_identity=${config.senderIdentity}, min_sender_trust=${config.minSenderTrust})`,
  );
  let nc: NatsConnection;
  try {
    nc = await natsConnect(
      withAgentReconnectDefaults({
        ...bundle.connectionOptions,
        name: "pi-headless",
      }),
    );
  } catch (e) {
    bundle.wipe();
    throw e;
  }
  log(`pi-headless: connected`);

  let manager: PiSessionManager | undefined;
  let controller: Controller;
  try {
    manager = new PiSessionManager({
      nc,
      owner: config.owner,
      signer: bundle.signer,
      minSenderTrust: config.minSenderTrust,
      defaultModel: config.defaultModel,
      defaultThinkingLevel: config.defaultThinkingLevel,
      defaultMaxLifetimeS: config.defaultMaxLifetimeS,
    });
    await manager.start();

    // Probe for an unclaimed controller name. With the default `control`,
    // a second pi-headless on the same NATS lands on `control-2`, a third
    // on `control-3`, and so on.
    const resolvedName = await resolveControllerName(
      nc,
      config.name,
      config.owner,
    );
    if (resolvedName !== config.name) {
      log(
        `pi-headless: name "${config.name}" is taken; using "${resolvedName}"`,
      );
    }

    controller = new Controller({
      nc,
      owner: config.owner,
      name: resolvedName,
      manager,
      signer: bundle.signer,
      minSenderTrust: config.minSenderTrust,
    });
    await controller.start();
  } catch (e) {
    await manager?.stop().catch(() => undefined);
    await nc.close();
    bundle.wipe();
    throw e;
  }

  const runningManager = manager;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true; // also gates the `close`-status notification below
    log(
      `pi-headless: received ${signal}, shutting down (${runningManager.count()} sessions)`,
    );
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
      await runningManager.stop();
    } catch (e) {
      log(`pi-headless: manager.stop error: ${(e as Error).message}`);
    }
    try {
      try {
        await nc.drain();
      } catch {
        // Drain can fail before reconnect state is terminal. Force close and
        // retain the bundle if that also fails so another signal can retry.
        await nc.close();
      }
      // Wipe only after close: reconnect authentication retains this same
      // credential snapshot for the connection's full lifetime.
      bundle?.wipe();
      bundle = undefined;
    } finally {
      clearTimeout(forceTimer);
    }
    process.exit(0);
  };

  const requestShutdown = (signal: string): void => {
    void shutdown(signal).catch((error: unknown) => {
      shuttingDown = false;
      log(`pi-headless: connection shutdown failed: ${(error as Error).message}`);
    });
  };
  process.on("SIGINT", () => requestShutdown("SIGINT"));
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));

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
        if (s.type === "disconnect")
          log(`pi-headless: NATS disconnected from ${s.server} — retrying…`);
        else if (s.type === "reconnect")
          log(`pi-headless: NATS reconnected to ${s.server}`);
        else if (s.type === "error")
          log(`pi-headless: NATS error: ${s.error.message}`);
        // Terminal — nats.js has stopped reconnecting.
        // `withAgentReconnectDefaults` sets `maxReconnectAttempts: -1`,
        // so this generally means a fatal auth error. During our own
        // shutdown `drain()` also emits `close`; skip the warning then.
        else if (s.type === "close" && !shuttingDown)
          log(
            "pi-headless: NATS connection closed — agent is off-bus until restart",
          );
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

// claude-code-headless entry point.
//
// Loads config, connects to NATS (via `nats context` when available),
// starts the ClaudeSessionManager and Controller, and wires graceful
// shutdown on SIGINT/SIGTERM.

import process from "node:process";

import type { NatsConnection } from "@nats-io/nats-core";
import type { NodeConnectionOptions } from "@nats-io/transport-node";
import { connect as natsConnect } from "@nats-io/transport-node";
import { loadContextOptions } from "@synadia-ai/agents";

import { ClaudeSessionManager } from "./claude-session-manager.js";
import { Controller } from "./controller.js";
import { loadConfig, parseCliOverrides } from "./config.js";

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function resolveNatsOptions(
  context: string | undefined,
  natsUrl: string | undefined,
): Promise<NodeConnectionOptions> {
  if (context) {
    return { ...(await loadContextOptions(context)), name: "claude-code-headless" };
  }
  if (natsUrl) {
    return { servers: natsUrl, name: "claude-code-headless" };
  }

  throw new Error("no NATS target configured (context / NATS_URL / --url)");
}

async function main(): Promise<void> {
  const cli = parseCliOverrides(process.argv.slice(2));
  const config = loadConfig(cli);

  // Informational only: the SDK accepts either an API key OR the local OAuth
  // credentials from `claude login`. We can't tell which is in play without
  // first spawning a session, so just hint at the fallback when the env var
  // is absent.
  if (!process.env["ANTHROPIC_API_KEY"]) {
    log(
      "claude-code-headless: no ANTHROPIC_API_KEY in env — sessions will fall back to local Claude Code OAuth credentials (~/.claude) if you've run `claude login`.",
    );
  }

  const connOpts = await resolveNatsOptions(config.context, config.natsUrl);
  log(
    `claude-code-headless: connecting (${config.context ? `context=${config.context}` : `url=${config.natsUrl}`})`,
  );
  const nc: NatsConnection = await natsConnect(connOpts);
  log(`claude-code-headless: connected`);

  const manager = new ClaudeSessionManager({
    nc,
    owner: config.owner,
    defaultModel: config.defaultModel,
    defaultPermissionMode: config.defaultPermissionMode,
    defaultAllowedTools: config.defaultAllowedTools,
    defaultMaxTurns: config.defaultMaxTurns,
    defaultMaxLifetimeS: config.defaultMaxLifetimeS,
  });
  await manager.start();

  const controller = new Controller({
    nc,
    owner: config.owner,
    name: config.name,
    manager,
  });
  await controller.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(
      `claude-code-headless: received ${signal}, shutting down (${manager.count()} sessions)`,
    );
    // Force-exit guard — NATS close can occasionally hang.
    const forceTimer = setTimeout(() => {
      log("claude-code-headless: forced exit");
      process.exit(1);
    }, 5_000);
    forceTimer.unref?.();
    try {
      await controller.stop();
    } catch (e) {
      log(`claude-code-headless: controller.stop error: ${(e as Error).message}`);
    }
    try {
      await manager.stop();
    } catch (e) {
      log(`claude-code-headless: manager.stop error: ${(e as Error).message}`);
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
    log(`claude-code-headless: unhandledRejection: ${err}`);
  });
  process.on("uncaughtException", (err) => {
    log(`claude-code-headless: uncaughtException: ${err}`);
  });

  // Background: NATS connection status logging.
  void (async () => {
    try {
      for await (const s of nc.status()) {
        if (s.type === "disconnect") log(`claude-code-headless: NATS disconnected`);
        else if (s.type === "reconnect") log(`claude-code-headless: NATS reconnected`);
        else if (s.type === "error") log(`claude-code-headless: NATS error`);
      }
    } catch {
      /* status iterator ended */
    }
  })();
}

main().catch((err) => {
  log(`claude-code-headless: fatal: ${(err as Error).message}`);
  process.exit(1);
});

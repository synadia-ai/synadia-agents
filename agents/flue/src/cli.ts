#!/usr/bin/env bun
import { connect as natsConnect } from "@nats-io/transport-node";
import { withAgentReconnectDefaults } from "@synadia-ai/agents";
import { helpText, loadConfigFromSources, parseArgs, renderConfigTemplate } from "./config.js";
import { resolveNatsBundle } from "./nats.js";
import { createFlueAgentService } from "./service.js";
import { formatDoctorChecks, runDoctorChecks } from "./doctor.js";
import pkg from "../package.json" assert { type: "json" };

async function start(): Promise<void> {
  const config = loadConfigFromSources();
  const connectionBundle = await resolveNatsBundle(config.nats);
  const nc = await natsConnect(withAgentReconnectDefaults(connectionBundle.connectionOptions)).catch((error: unknown) => {
    connectionBundle.wipe();
    throw error;
  });
  let service: ReturnType<typeof createFlueAgentService>;
  try {
    service = createFlueAgentService({ nc, config, version: pkg.version, connectionBundle });
    await service.start();
  } catch (error) {
    await nc.close();
    connectionBundle.wipe();
    throw error;
  }
  console.log(`flue agent listening on ${service.subject.prompt}`);
  console.log("press Ctrl+C to stop");
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nshutting down…");
    let exitCode = 0;
    try {
      await service.stop();
    } catch (error) {
      exitCode = 1;
      console.error(`flue-nats-channel service stop failed: ${(error as Error).message}`);
    }
    try {
      await nc.close();
    } finally {
      connectionBundle.wipe();
    }
    process.exit(exitCode);
  };
  const requestShutdown = (): void => {
    void shutdown().catch((error: unknown) => {
      console.error(`flue-nats-channel shutdown failed: ${(error as Error).message}`);
      process.exit(1);
    });
  };
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);
}

async function doctor(): Promise<void> {
  const config = loadConfigFromSources();
  const checks = await runDoctorChecks(config);
  console.log(formatDoctorChecks(checks));
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === "help") { console.log(helpText()); return; }
  if (args.command === "configure") {
    if (args.printTemplate) { console.log(renderConfigTemplate()); return; }
    console.log(helpText()); return;
  }
  if (args.command === "doctor") { await doctor(); return; }
  if (args.command === "start") { await start(); return; }
  throw new Error(`unknown command ${args.command}`);
}

void main().catch((err: unknown) => {
  console.error(`flue-nats-channel failed: ${(err as Error).message}`);
  process.exit(1);
});

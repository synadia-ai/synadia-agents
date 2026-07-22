#!/usr/bin/env bun
import { connect as natsConnect } from "@nats-io/transport-node";
import { helpText, loadConfigFromSources, parseArgs, renderConfigTemplate } from "./config.js";
import { resolveNatsOptions } from "./nats.js";
import { createEveAgentService } from "./service.js";
import { formatDoctorChecks, runDoctorChecks } from "./doctor.js";
import pkg from "../package.json" assert { type: "json" };

async function start(): Promise<void> {
  const config = loadConfigFromSources();
  const nc = await natsConnect(await resolveNatsOptions(config.nats));
  const service = createEveAgentService({ nc, config, version: pkg.version });
  await service.start();
  console.log(`eve agent listening on ${service.subject.prompt}`);
  console.log("press Ctrl+C to stop");
  const shutdown = async (): Promise<void> => {
    console.log("\nshutting down…");
    await service.stop();
    await nc.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
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
  console.error(`eve-nats-channel failed: ${(err as Error).message}`);
  process.exit(1);
});

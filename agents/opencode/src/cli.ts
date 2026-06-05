#!/usr/bin/env bun
import { connect as natsConnect } from "@nats-io/transport-node";
import { helpText, loadConfigFromSources, parseArgs, renderConfigTemplate } from "./config.js";
import { formatDoctorChecks, runDoctorChecks } from "./doctor.js";
import { resolveNatsOptions } from "./nats.js";
import { createOpenCodeClient } from "./opencode-client.js";
import { createOpenCodeAgentService } from "./service.js";
import pkg from "../package.json" assert { type: "json" };

async function start(): Promise<void> {
  const config = loadConfigFromSources();
  const client = await createOpenCodeClient(config);
  const nc = await natsConnect(await resolveNatsOptions(config.nats));
  const service = createOpenCodeAgentService({ nc, config, version: pkg.version, client });
  await service.start();
  console.log(`opencode agent listening on ${service.subject.prompt}`);
  console.log(`mode=${config.opencode.mode} owner=${config.agent.owner} session=${config.agent.name}`);
  console.log("press Ctrl+C to stop");

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nshutting down…");
    await service.stop();
    await client.close?.();
    await nc.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => undefined);
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
  console.error(`opencode-agent failed: ${(err as Error).message}`);
  process.exit(1);
});

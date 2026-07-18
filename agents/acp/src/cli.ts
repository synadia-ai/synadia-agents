#!/usr/bin/env bun
import { connect as natsConnect } from "@nats-io/transport-node";
import { readFileSync } from "node:fs";
import { FakeAcpBridgeClient, type AcpBridgeClient } from "./bridge.js";
import { helpText, loadConfigFromSources, parseArgs, renderConfigTemplate } from "./config.js";
import { runDoctor } from "./doctor.js";
import { ManagedAcpRuntime } from "./managed-runtime.js";
import { resolveNatsOptions } from "./nats.js";
import { createAcpAgentService } from "./service.js";

/**
 * Run the acp-agent CLI against an explicit argv (no trailing node/bun
 * prefix). Exported so thin per-agent wrapper packages (e.g.
 * `@synadia-ai/grok-nats-channel`) can pin preset defaults and delegate.
 */
export async function runCli(argv: readonly string[]): Promise<void> {
  const command = resolveCliCommand(argv);
  if (command === "help" || argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    return;
  }
  if (command === "configure" && argv.includes("--print-template")) {
    console.log(renderConfigTemplate());
    return;
  }

  const config = loadConfigFromSources({ argv });
  if (command === "doctor") {
    console.log(JSON.stringify(runDoctor(config), null, 2));
    return;
  }
  if (command !== "start") throw new Error(`unknown command ${command}`);

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  const client = await createBridgeClient(config);
  const nc = await natsConnect(await resolveNatsOptions(config.nats));
  const service = createAcpAgentService({
    nc,
    config,
    version: pkg.version ?? "0.0.0",
    client,
  });
  await service.start();
  console.log(`acp-agent (${config.acp.agentId}, ${config.acp.mode}) listening on ${service.subject.prompt}`);
  await waitForShutdown();
  await service.stop();
  await client.close?.();
  await nc.drain();
}

export function resolveCliCommand(argv: readonly string[]): string {
  return parseArgs(argv).command;
}

async function createBridgeClient(config: ReturnType<typeof loadConfigFromSources>): Promise<AcpBridgeClient> {
  if (config.acp.mode === "fake") return new FakeAcpBridgeClient();
  // Managed: start eagerly so spawn/auth failures surface at boot with a
  // clear message instead of as a 500 on the first NATS prompt.
  const runtime = new ManagedAcpRuntime({ config });
  await runtime.start();
  return runtime;
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

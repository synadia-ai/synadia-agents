#!/usr/bin/env bun
import { connect as natsConnect } from "@nats-io/transport-node";
import { readFileSync } from "node:fs";
import { FakeCodexBridgeClient, type CodexBridgeClient } from "./bridge.js";
import { helpText, loadConfigFromSources, renderConfigTemplate } from "./config.js";
import { runDoctor } from "./doctor.js";
import { ManagedCodexRuntime } from "./managed-runtime.js";
import { resolveNatsOptions } from "./nats.js";
import { createCodexAgentService } from "./service.js";

async function main(): Promise<void> {
  const config = loadConfigFromSources();
  const command = process.argv[2] ?? "help";
  if (config === undefined || command === "help" || process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(helpText());
    return;
  }
  if (command === "configure" && process.argv.includes("--print-template")) {
    console.log(renderConfigTemplate());
    return;
  }
  if (command === "doctor") {
    console.log(JSON.stringify(await runDoctor(config), null, 2));
    return;
  }
  if (command !== "start") throw new Error(`unknown command ${command}`);

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  const client = await createBridgeClient(config);
  const nc = await natsConnect(await resolveNatsOptions(config.nats));
  const service = createCodexAgentService({
    nc,
    config,
    version: pkg.version ?? "0.0.0",
    client,
  });
  await service.start();
  console.log(`codex-agent listening on ${service.subject.prompt}`);
  await waitForShutdown();
  await service.stop();
  await client.close?.();
  await nc.drain();
}

async function createBridgeClient(config: ReturnType<typeof loadConfigFromSources>): Promise<CodexBridgeClient> {
  if (config.codex.mode === "fake") return new FakeCodexBridgeClient();
  if (config.codex.mode === "managed") {
    const runtime = new ManagedCodexRuntime({ config, cwd: process.cwd() });
    await runtime.start();
    return runtime;
  }
  throw new Error(`Codex ${config.codex.mode} runtime is not implemented yet; use --mode managed or --mode fake`);
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

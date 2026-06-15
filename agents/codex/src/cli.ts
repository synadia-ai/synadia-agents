#!/usr/bin/env bun
import { connect as natsConnect } from "@nats-io/transport-node";
import { readFileSync } from "node:fs";
import { FakeCodexBridgeClient, type CodexBridgeClient } from "./bridge.js";
import { helpText, loadConfigFromSources, parseArgs, renderConfigTemplate } from "./config.js";
import { runDoctor } from "./doctor.js";
import { ManagedCodexRuntime } from "./managed-runtime.js";
import { AttachedCodexRuntime } from "./attached-runtime.js";
import { resolveNatsOptions } from "./nats.js";
import { createCodexAgentService } from "./service.js";
import { CodexSessionManager } from "./session-manager.js";

async function main(): Promise<void> {
  const config = loadConfigFromSources();
  const command = resolveCliCommand(process.argv.slice(2));
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
  if (command === "attach:doctor") {
    const runtime = new AttachedCodexRuntime({ config });
    try {
      const report = await runtime.start();
      console.log(JSON.stringify({ ...(await runDoctor(config)), attachPreflight: report }, null, 2));
    } finally {
      await runtime.close();
    }
    return;
  }
  if (command !== "start" && command !== "attach:start") throw new Error(`unknown command ${command}`);

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  const nc = await natsConnect(await resolveNatsOptions(config.nats));
  if (config.codex.mode === "manager") {
    const manager = new CodexSessionManager({ nc, config, version: pkg.version ?? "0.0.0" });
    const snapshots = await manager.start();
    console.log(`codex-agent manager listening for ${snapshots.length} sessions`);
    for (const snapshot of snapshots) console.log(snapshot.promptSubject);
    const stopCommands = installManagerCommands(manager);
    await waitForShutdown();
    stopCommands();
    await manager.stop();
    await nc.drain();
    return;
  }
  const client = await createBridgeClient(config);
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

export function resolveCliCommand(argv: readonly string[]): string {
  return parseArgs(argv).command;
}

async function createBridgeClient(config: ReturnType<typeof loadConfigFromSources>): Promise<CodexBridgeClient> {
  if (config.codex.mode === "fake") return new FakeCodexBridgeClient();
  if (config.codex.mode === "managed") {
    const runtime = new ManagedCodexRuntime({ config, cwd: process.cwd() });
    await runtime.start();
    return runtime;
  }
  if (config.codex.mode === "attached") {
    const runtime = new AttachedCodexRuntime({ config });
    await runtime.start();
    return runtime;
  }
  throw new Error(`Codex ${config.codex.mode} runtime is handled by the session manager path; use --mode managed, --mode attached, or --mode fake for single-session mode`);
}

function installManagerCommands(manager: CodexSessionManager): () => void {
  const onData = (chunk: Buffer | string): void => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const command = line.trim();
      if (!command) continue;
      if (command !== "rescan") {
        console.error(`unknown manager command ${command}; supported: rescan`);
        continue;
      }
      void manager.rescan()
        .then((snapshots) => {
          console.log(`codex-agent manager rescan complete: ${snapshots.length} sessions`);
          for (const snapshot of snapshots) console.log(snapshot.promptSubject);
        })
        .catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); });
    }
  };
  process.stdin.on("data", onData);
  return () => { process.stdin.off("data", onData); };
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

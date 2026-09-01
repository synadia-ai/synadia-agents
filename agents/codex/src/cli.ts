#!/usr/bin/env bun
import { connect as natsConnect } from "@nats-io/transport-node";
import { withAgentReconnectDefaults } from "@synadia-ai/agents";
import { readFileSync } from "node:fs";
import { FakeCodexBridgeClient, type CodexBridgeClient } from "./bridge.js";
import { helpText, loadConfigFromSources, parseArgs, renderConfigTemplate } from "./config.js";
import { runDoctor } from "./doctor.js";
import { ManagedCodexRuntime } from "./managed-runtime.js";
import { AttachedCodexRuntime } from "./attached-runtime.js";
import { resolveNatsBundle } from "./nats.js";
import { createCodexAgentService } from "./service.js";
import { CodexSessionManager } from "./session-manager.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = resolveCliCommand(argv);
  if (command === "help" || argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    return;
  }
  if (command === "configure" && argv.includes("--print-template")) {
    console.log(renderConfigTemplate());
    return;
  }

  const config = loadConfigFromSources();
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
  const connectionBundle = await resolveNatsBundle(config.nats);
  const nc = await natsConnect(withAgentReconnectDefaults(connectionBundle.connectionOptions)).catch((error: unknown) => {
    connectionBundle.wipe();
    throw error;
  });
  if (config.codex.mode === "manager") {
    const manager = new CodexSessionManager({ nc, config, version: pkg.version ?? "0.0.0", connectionBundle });
    let stopCommands: (() => void) | undefined;
    try {
      const snapshots = await manager.start();
      console.log(`codex-agent manager listening for ${snapshots.length} sessions`);
      if (manager.endpointErrorCount > 0) console.error(`codex-agent manager endpoint errors: ${manager.endpointErrorCount}`);
      for (const snapshot of snapshots) console.log(snapshot.promptSubject);
      stopCommands = installManagerCommands(manager);
      await waitForShutdown();
    } finally {
      stopCommands?.();
      try {
        await manager.stop();
      } finally {
        await nc.drain();
        connectionBundle.wipe();
      }
    }
    return;
  }
  let client: CodexBridgeClient | undefined;
  let service: ReturnType<typeof createCodexAgentService> | undefined;
  try {
    client = await createBridgeClient(config);
    service = createCodexAgentService({
      nc,
      config,
      version: pkg.version ?? "0.0.0",
      client,
      connectionBundle,
    });
    await service.start();
    console.log(`codex-agent listening on ${service.subject.prompt}`);
    await waitForShutdown();
  } finally {
    try {
      try {
        await service?.stop();
      } finally {
        await client?.close?.();
      }
    } finally {
      await nc.drain();
      connectionBundle.wipe();
    }
  }
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
          if (manager.endpointErrorCount > 0) console.error(`codex-agent manager endpoint errors: ${manager.endpointErrorCount}`);
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

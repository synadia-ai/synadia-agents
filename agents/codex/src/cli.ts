#!/usr/bin/env bun
import { connect as natsConnect } from "@nats-io/transport-node";
import { readFileSync } from "node:fs";
import { FakeCodexBridgeClient } from "./bridge.js";
import { helpText, loadConfigFromSources, renderConfigTemplate } from "./config.js";
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
    console.log(JSON.stringify(redactedDoctor(config), null, 2));
    return;
  }
  if (command !== "start") throw new Error(`unknown command ${command}`);
  if (config.codex.mode !== "fake") {
    throw new Error(`Codex ${config.codex.mode} runtime is not implemented in the initial scaffold; use --mode fake`);
  }

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  const nc = await natsConnect(await resolveNatsOptions(config.nats));
  const service = createCodexAgentService({
    nc,
    config,
    version: pkg.version ?? "0.0.0",
    client: new FakeCodexBridgeClient(),
  });
  await service.start();
  console.log(`codex-agent listening on ${service.subject.prompt}`);
  await waitForShutdown();
  await service.stop();
  await nc.drain();
}

function redactedDoctor(config: ReturnType<typeof loadConfigFromSources>): Record<string, unknown> {
  return {
    nats: {
      source: config.nats.context ? "context" : "url",
      url: config.nats.url ? safeOrigin(config.nats.url) : undefined,
      context: config.nats.context || undefined,
      creds: config.nats.creds ? "[REDACTED]" : undefined,
    },
    agent: config.agent,
    codex: {
      mode: config.codex.mode,
      codexBin: config.codex.codexBin,
      codeHome: config.codex.codeHome ? "[REDACTED]" : undefined,
      endpoint: config.codex.endpoint ? "[REDACTED]" : undefined,
      threadId: config.codex.threadId ? "[REDACTED]" : undefined,
      publicAlias: config.codex.publicAlias,
      permissionPolicy: config.codex.permissionPolicy,
    },
    manager: config.manager,
    phase: "protocol-scaffold",
  };
}

function safeOrigin(value: string): string {
  try { return new URL(value).origin; } catch { return "invalid-url"; }
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

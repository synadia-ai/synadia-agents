#!/usr/bin/env bun
import { connect as natsConnect } from "@nats-io/transport-node";
import { helpText, loadConfigFromSources, parseArgs, renderConfigTemplate } from "./config.js";
import { formatDoctorChecks, runDoctorChecks } from "./doctor.js";
import { resolveNatsOptions } from "./nats.js";
import { createOpenCodeClient } from "./opencode-client.js";
import { checkOpenCodePluginInstallation, installOpenCodePlugin, renderPluginEnvTemplate, uninstallOpenCodePlugin } from "./plugin/install.js";
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

async function plugin(argv: readonly string[]): Promise<void> {
  const subcommand = argv[0] ?? "help";
  if (subcommand === "print-env-template") { console.log(renderPluginEnvTemplate()); return; }
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") { console.log(pluginHelpText()); return; }
  const args = parseArgs(["plugin", ...argv.slice(1)]);
  const directory = args.directory ?? process.cwd();
  if (subcommand === "install") {
    const result = installOpenCodePlugin({ directory, ...optional("owner", args.owner), ...optional("session", args.name) });
    console.log(`installed OpenCode Synadia plugin wrapper: ${result.pluginPath}`);
    console.log(`updated OpenCode plugin package file: ${result.packageJsonPath}`);
    console.log("set runtime environment before starting opencode serve:");
    console.log(renderPluginEnvTemplate(result.env).trimEnd());
    return;
  }
  if (subcommand === "uninstall") {
    const result = uninstallOpenCodePlugin(directory);
    console.log(`${result.removed ? "removed" : "not installed"}: ${result.pluginPath}`);
    return;
  }
  if (subcommand === "doctor") {
    const result = checkOpenCodePluginInstallation(directory);
    console.log(`plugin wrapper ${result.pluginInstalled ? "present" : "missing"}: ${result.pluginPath}`);
    console.log(`plugin dependency ${result.dependencyInstalled ? "present" : "missing"}: ${result.packageJsonPath}`);
    if (!result.pluginInstalled || !result.dependencyInstalled) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown plugin command ${subcommand}`);
}

function pluginHelpText(): string {
  return `Usage: opencode-agent plugin <install|doctor|uninstall|print-env-template> [options]

Commands:
  plugin install              Install .opencode/plugins/synadia-channel.ts
  plugin doctor               Verify the local plugin wrapper and dependency
  plugin uninstall            Remove the generated plugin wrapper
  plugin print-env-template   Print safe runtime environment variables

Options:
  --directory PATH
  --owner TOKEN
  --session TOKEN
`;
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw[0] === "plugin") { await plugin(raw.slice(1)); return; }
  const args = parseArgs(raw);
  if (args.help || args.command === "help") { console.log(helpText()); return; }
  if (args.command === "configure") {
    if (args.printTemplate) { console.log(renderConfigTemplate()); return; }
    console.log(helpText()); return;
  }
  if (args.command === "doctor") { await doctor(); return; }
  if (args.command === "start") { await start(); return; }
  throw new Error(`unknown command ${args.command}`);
}

function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value ? { [key]: value } as Record<K, string> : {};
}

void main().catch((err: unknown) => {
  console.error(`opencode-agent failed: ${(err as Error).message}`);
  process.exit(1);
});

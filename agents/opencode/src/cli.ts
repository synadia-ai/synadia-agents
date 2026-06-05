#!/usr/bin/env bun
import { helpText, loadConfigFromSources, parseArgs, renderConfigTemplate } from "./config.js";
import { formatDoctorChecks, runDoctorChecks } from "./doctor.js";
import { buildPromptSubject } from "./subject.js";
import { OpenCodeAdapterNotImplementedError } from "./types.js";

async function start(): Promise<void> {
  const config = loadConfigFromSources();
  const subject = buildPromptSubject(config.agent.subjectToken, config.agent.owner, config.agent.name);
  throw new OpenCodeAdapterNotImplementedError(
    `opencode-agent start is scaffolded but not runnable yet for ${subject}; wire NATS connection, OpenCode SDK lifecycle, SSE event mapping, and permission handling before serving traffic.`,
  );
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

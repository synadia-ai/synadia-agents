#!/usr/bin/env bun
/**
 * `copilot-nats-agent serve`: run a headless GitHub Copilot agent (Copilot
 * SDK) on the Synadia Agent Protocol for NATS fleet. Flags override the
 * matching environment variables, which override the config file.
 */

import { CopilotClient, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";

import { findConfigFile, loadConfigFile, resolveServeSettings, resolveSettings } from "./config.js";
import type { Log } from "./runtime.js";
import { CopilotServe, type ServeClient, type ServeSession, type ServeSessionConfig } from "./serve.js";

/** Flag → environment variable it sets. */
const FLAGS: Readonly<Record<string, string>> = {
  "--config": "SYNADIA_COPILOT_CONFIG",
  "--context": "NATS_CONTEXT",
  "--url": "NATS_URL",
  "--creds": "NATS_CREDS",
  "--owner": "SYNADIA_COPILOT_OWNER",
  "--name": "SYNADIA_COPILOT_NAME",
  "--description": "SYNADIA_COPILOT_DESCRIPTION",
  "--sender-identity": "NATS_SENDER_IDENTITY",
  "--min-sender-trust": "NATS_MIN_SENDER_TRUST",
  "--allow-senders": "SYNADIA_COPILOT_ALLOW_SENDERS",
  "--permissions": "SYNADIA_COPILOT_SERVE_PERMISSIONS",
  "--permission-timeout-ms": "SYNADIA_COPILOT_PERMISSION_TIMEOUT_MS",
  "--queue-limit": "SYNADIA_COPILOT_QUEUE_LIMIT",
  "--model": "SYNADIA_COPILOT_MODEL",
  "--reasoning-effort": "SYNADIA_COPILOT_REASONING_EFFORT",
  "--cwd": "SYNADIA_COPILOT_CWD",
  "--agent-tools": "SYNADIA_COPILOT_SERVE_AGENT_TOOLS",
  "--tool-prefix": "SYNADIA_COPILOT_TOOL_PREFIX",
  "--max-sessions": "SYNADIA_COPILOT_MAX_SESSIONS",
  "--state-file": "SYNADIA_COPILOT_STATE_FILE",
};

export const USAGE = `Usage: copilot-nats-agent serve [options]

Run a headless GitHub Copilot agent (Copilot SDK) on the NATS agent fleet.

NATS:
  --context <name>             NATS CLI context            (NATS_CONTEXT)
  --url <url>                  server URL                  (NATS_URL, default nats://127.0.0.1:4222)
  --creds <file>               credentials file            (NATS_CREDS)
  --owner <token>              owner subject token         (SYNADIA_COPILOT_OWNER)
  --name <token>               instance name               (SYNADIA_COPILOT_NAME, default serve-<host>)
  --sender-identity off|signed sign replies (§13)          (NATS_SENDER_IDENTITY)
Callers:
  --min-sender-trust any|signed                            (NATS_MIN_SENDER_TRUST, default any)
  --allow-senders <id,...>     only these verified senders (SYNADIA_COPILOT_ALLOW_SENDERS)
  --permissions query|deny     ask the verified caller, or deny all (default query)
  --permission-timeout-ms <n>  how long to wait for an answer (default 120000)
  --queue-limit <n>            prompts queued per conversation (default 8)
Copilot:
  --model <id>                 e.g. claude-haiku-4.5       (SYNADIA_COPILOT_MODEL)
  --reasoning-effort low|medium|high|xhigh|max (omit for models without it)
  --cwd <dir>                  session working directory   (default: current directory)
  --agent-tools off|blocking|all  fleet tools for the model (default off)
  --max-sessions <n>           open Copilot sessions       (default 8)
  --state-file <path>          conversation -> session map (default ~/.copilot/synadia-nats/serve-*.json)
  --config <file>              JSON config                 (SYNADIA_COPILOT_CONFIG)
`;

/** Parse argv into the environment serve resolves its settings from. */
export function parseServeArgs(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const target = FLAGS[flag];
    if (!target) throw new Error(`unknown option ${flag}\n\n${USAGE}`);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || (eq < 0 && value.startsWith("--"))) throw new Error(`${flag} needs a value`);
    out[target] = value;
  }
  return out;
}

/** The real `CopilotClient`, adapted to the surface serve uses. */
export function copilotClient(cwd: string): ServeClient {
  const client = new CopilotClient({ workingDirectory: cwd, logLevel: "error" });
  const adapt = (session: CopilotSession): ServeSession => ({
    sessionId: session.sessionId,
    send: (options) => session.send(options),
    on: (handler) => session.on((event) => handler(event as never)),
    disconnect: () => session.disconnect(),
  });
  const toConfig = (config: ServeSessionConfig) => config as unknown as SessionConfig;
  return {
    start: () => client.start(),
    stop: () => client.stop(),
    createSession: async (config) => adapt(await client.createSession(toConfig(config))),
    resumeSession: async (id, config) => adapt(await client.resumeSession(id, toConfig(config))),
  };
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== "serve") {
    process.stderr.write(`unknown command ${command}\n\n${USAGE}`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const env = parseServeArgs(rest, process.env);
  const configFile = findConfigFile(env, undefined);
  const config = loadConfigFile(configFile);
  const settings = resolveSettings(config, env, configFile);
  const serve = resolveServeSettings(config, env, settings);
  const log: Log = (message, level = "info") =>
    (level === "info" ? process.stdout : process.stderr).write(`${new Date().toISOString()} ${message}\n`);

  const agent = new CopilotServe({ settings, serve, client: copilotClient(serve.cwd), log });
  await agent.start();
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  log("synadia-nats serve: shutting down");
  await agent.stop();
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`copilot-nats-agent: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}

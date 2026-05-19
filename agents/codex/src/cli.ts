#!/usr/bin/env bun
// CLI entrypoint for the codex NATS channel.
//
// Resolves owner / session / cwd from flags + env (+ optional config
// file), connects NATS, and hands off to `runBridge`. SIGINT / SIGTERM
// trigger a graceful stop.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { runBridge, AGENT_TOKEN } from "./bridge.js";
import { connectFrom, loadChannelConfig } from "./nats-context.js";

interface ParsedArgs {
  owner: string;
  session: string;
  cwd: string;
  natsContext?: string;
  natsUrl?: string;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const out: Record<string, string> = {};
  const args = [...argv];
  while (args.length > 0) {
    const a = args.shift() as string;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = args[0];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      args.shift();
      out[key] = next;
    }
  }

  const config = loadChannelConfig();

  const owner =
    out["owner"] ??
    process.env["CODEX_AGENT_OWNER"] ??
    config.owner ??
    process.env["USER"] ??
    "anon";
  const session =
    out["session"] ??
    process.env["CODEX_AGENT_SESSION"] ??
    config.session ??
    "default";
  const cwd =
    out["cwd"] ??
    process.env["CODEX_AGENT_CWD"] ??
    join(tmpdir(), "codex-agent", session);

  const natsContext = out["nats-context"];
  const natsUrl = out["nats-url"] ?? process.env["NATS_URL"];

  return {
    owner,
    session,
    cwd,
    ...(natsContext !== undefined ? { natsContext } : {}),
    ...(natsUrl !== undefined && natsUrl.length > 0 ? { natsUrl } : {}),
  };
}

const stderrLogger = {
  debug(msg: string, ctx?: Record<string, unknown>): void {
    process.stderr.write(formatLine("debug", msg, ctx));
  },
  info(msg: string, ctx?: Record<string, unknown>): void {
    process.stderr.write(formatLine("info", msg, ctx));
  },
  warn(msg: string, ctx?: Record<string, unknown>): void {
    process.stderr.write(formatLine("warn", msg, ctx));
  },
  error(msg: string, ctx?: Record<string, unknown>): void {
    process.stderr.write(formatLine("error", msg, ctx));
  },
};

function formatLine(level: string, msg: string, ctx?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const ctxStr = ctx ? " " + JSON.stringify(ctx) : "";
  return `${timestamp} ${level} ${msg}${ctxStr}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  mkdirSync(args.cwd, { recursive: true });

  const config = loadChannelConfig();
  const nc = await connectFrom({
    ...(args.natsContext !== undefined ? { natsContext: args.natsContext } : {}),
    ...(args.natsUrl !== undefined ? { natsUrl: args.natsUrl } : {}),
    config,
  });

  const { stop } = await runBridge({
    nc,
    owner: args.owner,
    session: args.session,
    cwd: args.cwd,
    logger: stderrLogger,
  });

  stderrLogger.info(`${AGENT_TOKEN}: ready`, {
    subject: `agents.prompt.${AGENT_TOKEN}.${args.owner}.${args.session}`,
    cwd: args.cwd,
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    stderrLogger.info(`${AGENT_TOKEN}: ${signal} received, shutting down`);
    try {
      await stop();
      await nc.close();
    } catch (err) {
      stderrLogger.error(`${AGENT_TOKEN}: shutdown error`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  stderrLogger.error(`${AGENT_TOKEN}: startup failed`, {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

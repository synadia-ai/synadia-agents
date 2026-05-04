#!/usr/bin/env bun
// CLI entrypoint. Parses flags + env, connects to NATS, builds a
// `LocalSandbox`, hands off to `runBridge`. SIGINT/SIGTERM trigger a
// graceful stop.
//
// Logs go to stderr; stdout is reserved for future structured output.
//
// Provider selection (see README "Models" section):
//   OPEN_AGENT_PROVIDER=gateway   → Vercel AI Gateway (default).
//                                   Auth via AI_GATEWAY_API_KEY.
//                                   Models like `anthropic/claude-opus-4.6`.
//   OPEN_AGENT_PROVIDER=openrouter → OpenRouter.
//                                   Auth via OPENROUTER_API_KEY.
//                                   Models like `anthropic/claude-sonnet-4`.
// When `OPEN_AGENT_PROVIDER` is unset, we auto-select OpenRouter if
// `OPENROUTER_API_KEY` is set (and `AI_GATEWAY_API_KEY` is not), otherwise
// Gateway.

import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { runBridge } from "./bridge.js";
import {
  gatewayModelFactory,
  openRouterModelFactory,
  type ModelFactory,
} from "./model-factory.js";
import { connectFrom } from "./nats-context.js";
import { connectLocalSandbox } from "../vendor/sandbox/local.js";
import { defaultModelLabel } from "../vendor/agent/open-agent.js";

type ProviderName = "gateway" | "openrouter";

interface ParsedArgs {
  owner: string;
  session: string;
  workdir: string;
  natsContext?: string;
  natsUrl?: string;
  provider: ProviderName;
  model: string;
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

  const owner =
    out["owner"] ?? process.env["OPEN_AGENT_OWNER"] ?? process.env["USER"] ?? "anon";
  const session = out["session"] ?? process.env["OPEN_AGENT_SESSION"] ?? "default";
  const workdir =
    out["workdir"] ??
    process.env["OPEN_AGENT_WORKDIR"] ??
    join(tmpdir(), "open-agent", session);
  const natsContext = out["nats-context"];
  const natsUrl = process.env["NATS_URL"];

  const providerEnv = (out["provider"] ?? process.env["OPEN_AGENT_PROVIDER"])?.toLowerCase();
  const provider: ProviderName =
    providerEnv === "openrouter"
      ? "openrouter"
      : providerEnv === "gateway"
        ? "gateway"
        : process.env["OPENROUTER_API_KEY"] && !process.env["AI_GATEWAY_API_KEY"]
          ? "openrouter"
          : "gateway";

  // OpenRouter has no sensible default model — the user must pick one
  // from the catalog. Gateway falls back to upstream open-agents'
  // `defaultModelLabel`.
  const model =
    process.env["OPEN_AGENT_MODEL"] ?? (provider === "gateway" ? defaultModelLabel : "");

  return {
    owner,
    session,
    workdir,
    ...(natsContext !== undefined ? { natsContext } : {}),
    ...(natsUrl !== undefined && natsUrl.length > 0 ? { natsUrl } : {}),
    provider,
    model,
  };
}

function buildModelFactory(args: ParsedArgs): ModelFactory {
  if (args.provider === "openrouter") {
    if (args.model.length === 0) {
      throw new Error(
        "OPEN_AGENT_PROVIDER=openrouter requires OPEN_AGENT_MODEL — pick a slug from " +
          "https://openrouter.ai/models (e.g. `anthropic/claude-sonnet-4`).",
      );
    }
    if (!process.env["OPENROUTER_API_KEY"]) {
      throw new Error(
        "OPEN_AGENT_PROVIDER=openrouter requires OPENROUTER_API_KEY — get a key at " +
          "https://openrouter.ai/keys.",
      );
    }
    return openRouterModelFactory({
      appTitle: "Synadia open-agent bridge",
      httpReferer: "https://github.com/synadia-ai/synadia-agents",
    });
  }
  if (!process.env["AI_GATEWAY_API_KEY"]) {
    throw new Error(
      "OPEN_AGENT_PROVIDER=gateway (default) requires AI_GATEWAY_API_KEY — get a key at " +
        "https://vercel.com/dashboard/ai-gateway. Set OPEN_AGENT_PROVIDER=openrouter and " +
        "OPENROUTER_API_KEY to use OpenRouter instead.",
    );
  }
  return gatewayModelFactory();
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
  const modelFactory = buildModelFactory(args);

  const nc = await connectFrom({
    ...(args.natsContext !== undefined ? { natsContext: args.natsContext } : {}),
    ...(args.natsUrl !== undefined ? { natsUrl: args.natsUrl } : {}),
  });

  const { stop } = await runBridge({
    nc,
    owner: args.owner,
    session: args.session,
    sandboxFactory: async () => {
      const sandbox = await connectLocalSandbox({
        type: "local",
        workingDirectory: args.workdir,
      });
      return {
        sandbox,
        state: { type: "local", workingDirectory: args.workdir },
      };
    },
    modelId: args.model,
    modelFactory,
    workingDirectoryHint: args.workdir,
    logger: stderrLogger,
  });

  stderrLogger.info("open-agent: ready", {
    subject: `agents.prompt.open-agent.${args.owner}.${args.session}`,
    workdir: args.workdir,
    provider: args.provider,
    model: args.model,
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    stderrLogger.info(`open-agent: ${signal} received, shutting down`);
    try {
      await stop();
      await nc.close();
    } catch (err) {
      stderrLogger.error("open-agent: shutdown error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  stderrLogger.error("open-agent: startup failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

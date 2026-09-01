#!/usr/bin/env bun
// open-agent + Vercel Sandbox demo. Runs the same `runBridge` exported
// from `@synadia-ai/open-agent`, but with `connectVercelSandbox` plugged
// in instead of `LocalSandbox`. Validates that the bridge has no
// hard-wired sandbox dependency.

import process from "node:process";

import {
  connectFrom,
  gatewayModelFactory,
  openRouterModelFactory,
  runBridge,
  type ModelFactory,
} from "@synadia-ai/open-agent";
import { connectVercelSandbox } from "../vendor/vercel/index.js";
import { resolveVercelNatsSettings } from "./config.js";

// Same NATS contract as agents/open-agent: flag context > env context > URL >
// localhost, with identity-free/permissive defaults.
const natsSettings = resolveVercelNatsSettings(process.argv.slice(2));
const OWNER =
  process.env["OPEN_AGENT_OWNER"] ?? process.env["USER"] ?? "vercel-demo";
const SESSION = process.env["OPEN_AGENT_SESSION"] ?? "default";
const REPO_URL = process.env["OPEN_AGENT_REPO_URL"]; // optional GitHub URL to clone
const MODEL = process.env["OPEN_AGENT_MODEL"];

if (!process.env["VERCEL_TOKEN"]) {
  console.error(
    "VERCEL_TOKEN is not set — connectVercelSandbox needs Vercel API credentials.",
  );
  process.exit(1);
}

// Same provider selection as the CLI in agents/open-agent. See that
// package's README "Models" section for the tradeoff between Gateway and
// OpenRouter (notably: OpenRouter goes through plain chat completions
// with no Anthropic adaptive thinking, no GPT-5 reasoning defaults, and
// no OpenAI `store:false` middleware — those only apply on Gateway).
const providerEnv = process.env["OPEN_AGENT_PROVIDER"]?.toLowerCase();
const provider: "gateway" | "openrouter" =
  providerEnv === "openrouter"
    ? "openrouter"
    : providerEnv === "gateway"
      ? "gateway"
      : process.env["OPENROUTER_API_KEY"] && !process.env["AI_GATEWAY_API_KEY"]
        ? "openrouter"
        : "gateway";

let modelFactory: ModelFactory;
if (provider === "openrouter") {
  if (!process.env["OPENROUTER_API_KEY"]) {
    console.error(
      "OPEN_AGENT_PROVIDER=openrouter requires OPENROUTER_API_KEY.",
    );
    process.exit(1);
  }
  if (MODEL === undefined || MODEL.length === 0) {
    console.error(
      "OPEN_AGENT_PROVIDER=openrouter requires OPEN_AGENT_MODEL — pick a slug from " +
        "https://openrouter.ai/models.",
    );
    process.exit(1);
  }
  modelFactory = openRouterModelFactory({
    appTitle: "Synadia open-agent (Vercel sandbox)",
    httpReferer: "https://github.com/synadia-ai/synadia-agents",
  });
} else {
  if (!process.env["AI_GATEWAY_API_KEY"]) {
    console.error(
      "OPEN_AGENT_PROVIDER=gateway (default) requires AI_GATEWAY_API_KEY — get a key at " +
        "https://vercel.com/dashboard/ai-gateway, or set OPEN_AGENT_PROVIDER=openrouter.",
    );
    process.exit(1);
  }
  modelFactory = gatewayModelFactory();
}

const { nc, bundle: connectionBundle } = await connectFrom({
  ...(natsSettings.natsContext !== undefined
    ? { natsContext: natsSettings.natsContext }
    : {}),
  ...(natsSettings.natsUrl !== undefined
    ? { natsUrl: natsSettings.natsUrl }
    : {}),
  senderIdentity: natsSettings.senderIdentity,
});

let stop: () => Promise<void>;
try {
  ({ stop } = await runBridge({
    nc,
    owner: OWNER,
    session: SESSION,
    sandboxFactory: async (sessionId) => {
      const sandbox = await connectVercelSandbox({
        name: sessionId,
        ...(REPO_URL !== undefined ? { source: { url: REPO_URL } } : {}),
      });
      const liveState =
        typeof sandbox.getState === "function"
          ? (sandbox.getState() as unknown as Record<string, unknown>)
          : ({ sandboxName: sessionId } as Record<string, unknown>);
      return {
        sandbox,
        state: { type: "vercel", ...liveState },
      };
    },
    modelFactory,
    ...(MODEL !== undefined && MODEL.length > 0 ? { modelId: MODEL } : {}),
    workingDirectoryHint: "(Vercel sandbox)",
    connectionBundle,
    minSenderTrust: natsSettings.minSenderTrust,
  }));
} catch (error) {
  await nc.close();
  connectionBundle.wipe();
  throw error;
}

console.log(
  `open-agent-vercel: listening on agents.prompt.open-agent.${OWNER}.${SESSION}`,
);
console.log(
  `sender identity=${natsSettings.senderIdentity}; minimum sender trust=${natsSettings.minSenderTrust}`,
);
console.log("press Ctrl+C to stop");

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} — shutting down`);
  let exitCode = 0;
  try {
    await stop();
  } catch (error) {
    exitCode = 1;
    console.error(
      `open-agent-vercel: stop failed: ${(error as Error).message}`,
    );
  }
  await nc.close();
  // Reconnect auth and the signer share this retained credential snapshot;
  // wipe it only after the connection is closed.
  connectionBundle.wipe();
  process.exit(exitCode);
};

const requestShutdown = (signal: string): void => {
  void shutdown(signal).catch((error: unknown) => {
    stopping = false;
    console.error(`open-agent-vercel: connection shutdown failed: ${(error as Error).message}`);
  });
};
process.on("SIGINT", () => requestShutdown("SIGINT"));
process.on("SIGTERM", () => requestShutdown("SIGTERM"));

// LLM agent (combined) — answers prompts with Ollama OR OpenRouter.
//
// Step 4 of the example ladder, and the reusable base later agents build on. It
// defers all model access to ./llm.ts, which auto-selects a backend from the
// environment:
//
//   OPENROUTER_API_KEY set  → OpenRouter (OPENROUTER_MODEL)
//   otherwise               → local Ollama (OLLAMA_MODEL, OLLAMA_URL)
//
// The agent itself is unchanged from 01-echo's shape — connect, construct,
// onPrompt, start — except the handler streams LLM tokens instead of an echo.
//
// Connection resolution (same as 01-echo.ts):
//   1. $NATS_CONTEXT — name of a NATS CLI context under ~/.config/nats/context/
//   2. $NATS_URL     — raw URL (credentials in userinfo are honored)
//   3. nats://127.0.0.1:4222

import { connect as natsConnect } from "@nats-io/transport-node";
import { loadContextOptions, parseNatsUrl } from "@synadia-ai/agents";
import { AgentService } from "@synadia-ai/agent-service";
import { createLlmClient } from "./llm";

async function main(): Promise<void> {
  const llm = createLlmClient();

  const opts = process.env["NATS_CONTEXT"]
    ? await loadContextOptions(process.env["NATS_CONTEXT"])
    : process.env["NATS_URL"]
      ? parseNatsUrl(process.env["NATS_URL"])
      : { servers: "nats://127.0.0.1:4222" };
  const nc = await natsConnect(opts);

  // Identity and heartbeat cadence are env-overridable (see 01-echo.ts).
  const heartbeatIntervalS = Number(process.env["NATS_AGENT_HEARTBEAT_INTERVAL"]) || undefined;
  const service = new AgentService({
    nc,
    agent: "llm",
    owner:
      process.env["SYNADIA_LLM_OWNER"] ??
      process.env["SYNADIA_OWNER"] ??
      process.env["NATS_AGENT_OWNER"] ??
      process.env["USER"] ??
      "anon",
    name:
      process.env["SYNADIA_LLM_NAME"] ??
      process.env["SYNADIA_NAME"] ??
      process.env["NATS_AGENT_NAME"] ??
      "main",
    ...(heartbeatIntervalS !== undefined ? { heartbeatIntervalS } : {}),
    description: `LLM agent — answers prompts via ${llm.label}`,
  });

  // Wrap the prompt as a single user message and stream the model's reply. A
  // tool-calling agent (see 05-tools.ts) extends this same pattern — adding a
  // non-streamed round-trip for tool dispatch before the final streamed answer.
  service.onPrompt(async (envelope, response) => {
    for await (const token of llm.chatStream([{ role: "user", content: envelope.prompt }])) {
      await response.send(token);
    }
  });

  await service.start();
  console.log(`llm agent listening on ${service.subject.prompt}`);
  console.log(`backend: ${llm.label}`);
  console.log("press Ctrl+C to stop");

  const shutdown = async (): Promise<void> => {
    console.log("\nshutting down…");
    await service.stop();
    await nc.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((err: unknown) => {
  console.error("llm agent failed:", err);
  process.exit(1);
});

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
// Connection and optional signed registration use the shared atomic bundle in
// `_connection.ts`; see 01-echo.ts or README.md for env precedence.

import { AgentService } from "@synadia-ai/agent-service";
import { createLlmClient } from "./llm";
import { openExampleNatsConnection, waitForTermination } from "./_connection";

async function main(): Promise<void> {
  const llm = createLlmClient();

  const connection = await openExampleNatsConnection();
  let service: AgentService | undefined;

  try {
    // Identity and heartbeat cadence are env-overridable (see 01-echo.ts).
    const heartbeatIntervalS = Number(process.env["NATS_AGENT_HEARTBEAT_INTERVAL"]) || undefined;
    service = new AgentService({
      nc: connection.nc,
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
      ...(connection.signer ? { identity: { signer: connection.signer } } : {}),
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
    await waitForTermination();
    console.log("\nshutting down…");
  } finally {
    try {
      await service?.stop();
    } finally {
      await connection.close();
    }
  }
}

void main().catch((err: unknown) => {
  console.error("llm agent failed:", err);
  process.exit(1);
});

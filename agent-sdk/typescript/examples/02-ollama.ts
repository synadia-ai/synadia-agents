// LLM agent — forwards each prompt to a local Ollama and streams the reply.
//
// Step 2 of the example ladder: take the echo agent (`01-echo.ts`) and swap
// the one-line `echo: <prompt>` reply for a real LLM round-trip. The shape is
// identical — only the `onPrompt` body changes. Tokens are streamed back to
// the caller as they arrive, so the front-end sees the answer render live.
//
// Prerequisites: a local Ollama (https://ollama.com) with the model pulled:
//   ollama pull llama3.2
//
// Connection resolution (same as 01-echo.ts):
//   1. $NATS_CONTEXT — name of a NATS CLI context under ~/.config/nats/context/
//   2. $NATS_URL     — raw URL (credentials in userinfo are honored)
//   3. nats://127.0.0.1:4222

import { connect as natsConnect } from "@nats-io/transport-node";
import { loadContextOptions, parseNatsUrl } from "@synadia-ai/agents";
import { AgentService } from "@synadia-ai/agent-service";

// Which model to prompt, and where Ollama lives. Override either from the
// environment, or just edit the defaults below.
const MODEL = process.env["OLLAMA_MODEL"] ?? "llama3.2";
const OLLAMA_URL = process.env["OLLAMA_URL"] ?? "http://localhost:11434";

/**
 * Stream a completion from Ollama, yielding each token as it arrives.
 *
 * Ollama's `/api/generate` returns newline-delimited JSON — one object per
 * line, each carrying the next `response` fragment until a final `done`. We
 * read the HTTP body as a stream and re-assemble those lines as they trickle
 * in, so tokens flow out the moment the model produces them.
 */
async function* ollamaTokens(prompt: string): AsyncGenerator<string> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, stream: true }),
  });
  if (!res.ok || res.body === null) {
    throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of res.body) {
    buffer += decoder.decode(bytes as Uint8Array, { stream: true });
    // A network read may split mid-line; keep the trailing partial in `buffer`.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      // The final `{"done":true,"response":""}` packet carries no text — skip
      // empties so we never stream a vacuous chunk to the caller.
      const token = (JSON.parse(line) as { response?: string }).response ?? "";
      if (token) yield token;
    }
  }
}

async function main(): Promise<void> {
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
    agent: "ollama",
    owner:
      process.env["SYNADIA_OLLAMA_OWNER"] ??
      process.env["SYNADIA_OWNER"] ??
      process.env["NATS_AGENT_OWNER"] ??
      process.env["USER"] ??
      "anon",
    name:
      process.env["SYNADIA_OLLAMA_NAME"] ??
      process.env["SYNADIA_NAME"] ??
      process.env["NATS_AGENT_NAME"] ??
      "main",
    ...(heartbeatIntervalS !== undefined ? { heartbeatIntervalS } : {}),
    description: `LLM agent — answers prompts with the local Ollama '${MODEL}' model`,
  });

  // Same handler shape as the echo agent: instead of one reply, we `send(...)`
  // each token as Ollama emits it. The SDK closes the stream when we return.
  service.onPrompt(async (envelope, response) => {
    for await (const token of ollamaTokens(envelope.prompt)) {
      await response.send(token);
    }
  });

  await service.start();
  console.log(`ollama agent listening on ${service.subject.prompt}`);
  console.log(`prompting model '${MODEL}' at ${OLLAMA_URL}`);
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
  console.error("ollama agent failed:", err);
  process.exit(1);
});

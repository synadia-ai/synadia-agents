// LLM agent — forwards each prompt to OpenRouter and streams the reply.
//
// Step 3 of the example ladder. Same shape as `02-ollama.ts`, but the backend
// is the hosted, OpenAI-compatible OpenRouter API instead of a local Ollama.
// Needs an API key; no GPU required.
//
// Prerequisites: an OpenRouter API key (https://openrouter.ai/keys):
//   export OPENROUTER_API_KEY=sk-or-...
//   # optional: export OPENROUTER_MODEL=openai/gpt-4o-mini
//
// Connection and optional signed registration use the shared atomic bundle in
// `_connection.ts`; see 01-echo.ts or README.md for env precedence.

import { AgentService } from "@synadia-ai/agent-service";
import { openExampleNatsConnection, waitForTermination } from "./_connection";

const API_KEY = process.env["OPENROUTER_API_KEY"];
const MODEL = process.env["OPENROUTER_MODEL"] ?? "openai/gpt-4o-mini";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Stream a chat completion from OpenRouter, yielding each token as it arrives.
 *
 * OpenRouter speaks the OpenAI SSE format: lines of `data: {json}` (plus keep-
 * alive comments), ending with `data: [DONE]`. Each JSON frame carries the next
 * fragment at `choices[0].delta.content`. As in `02-ollama.ts`, a network read
 * may split mid-line, so we keep the trailing partial in `buffer`.
 */
async function* openRouterTokens(prompt: string): AsyncGenerator<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    }),
  });
  if (!res.ok || res.body === null) {
    throw new Error(`OpenRouter request failed: ${res.status} ${res.statusText}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of res.body) {
    buffer += decoder.decode(bytes as Uint8Array, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue; // skip SSE keep-alive comments
      const data = trimmed.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      try {
        const token =
          (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta
            ?.content ?? "";
        if (token) yield token;
      } catch {
        /* ignore the rare non-JSON keep-alive line */
      }
    }
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("OPENROUTER_API_KEY is not set — get one at https://openrouter.ai/keys");
    process.exit(1);
  }

  const connection = await openExampleNatsConnection();
  let service: AgentService | undefined;

  try {
    // Identity and heartbeat cadence are env-overridable (see 01-echo.ts).
    const heartbeatIntervalS = Number(process.env["NATS_AGENT_HEARTBEAT_INTERVAL"]) || undefined;
    service = new AgentService({
      nc: connection.nc,
      agent: "openrouter",
      owner:
        process.env["SYNADIA_OPENROUTER_OWNER"] ??
        process.env["SYNADIA_OWNER"] ??
        process.env["NATS_AGENT_OWNER"] ??
        process.env["USER"] ??
        "anon",
      name:
        process.env["SYNADIA_OPENROUTER_NAME"] ??
        process.env["SYNADIA_NAME"] ??
        process.env["NATS_AGENT_NAME"] ??
        "main",
      ...(heartbeatIntervalS !== undefined ? { heartbeatIntervalS } : {}),
      ...(connection.signer ? { identity: { signer: connection.signer } } : {}),
      description: `LLM agent — answers prompts with OpenRouter '${MODEL}'`,
    });

    // Same handler shape as the echo agent: instead of one reply, we `send(...)`
    // each token as OpenRouter emits it. The SDK closes the stream when we return.
    service.onPrompt(async (envelope, response) => {
      for await (const token of openRouterTokens(envelope.prompt)) {
        await response.send(token);
      }
    });

    await service.start();
    console.log(`openrouter agent listening on ${service.subject.prompt}`);
    console.log(`prompting model '${MODEL}' via OpenRouter`);
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
  console.error("openrouter agent failed:", err);
  process.exit(1);
});

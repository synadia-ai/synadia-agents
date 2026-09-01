// LLM agent — forwards each prompt to a local Ollama and streams the reply.
//
// Step 2 of the example ladder: take the echo agent (`01-echo.ts`) and swap
// the one-line `echo: <prompt>` reply for a real LLM round-trip. The shape is
// identical — only the `onPrompt` body changes. Tokens are streamed back to
// the caller as they arrive, so the front-end sees the answer render live.
//
// The completion rides Ollama's OpenAI-compatible endpoint
// (`/v1/chat/completions`, SSE) rather than the native `/api/generate` — so
// `OLLAMA_URL` accepts anything that speaks that wire shape: a local Ollama
// (the default), or an OpenAI-style metering/audit proxy sitting in front of
// one (e.g. a synadia-model-proxy per-agent identity URL).
//
// Prerequisites: a local Ollama (https://ollama.com) with the model pulled:
//   ollama pull llama3.2
//
// Connection and optional signed registration use the shared atomic bundle in
// `_connection.ts`; see 01-echo.ts or README.md for env precedence.

import { AgentService } from "@synadia-ai/agent-service";
import { openExampleNatsConnection, waitForTermination } from "./_connection";

// Which model to prompt, and where the OpenAI-compatible endpoint lives.
// Override either from the environment, or just edit the defaults below.
const MODEL = process.env["OLLAMA_MODEL"] ?? "llama3.2";
const OLLAMA_URL = process.env["OLLAMA_URL"] ?? "http://localhost:11434";

/**
 * Stream a completion from the OpenAI-compatible chat endpoint, yielding each
 * token as it arrives.
 *
 * `POST {OLLAMA_URL}/v1/chat/completions` with `stream: true` answers with
 * OpenAI-style SSE: `data: {json}` lines whose `choices[0].delta.content`
 * carries the next text fragment, closed by `data: [DONE]`. We read the HTTP
 * body as a stream and re-assemble lines as they trickle in, so tokens flow
 * out the moment the model produces them (same parsing as `03-openrouter.ts`).
 */
async function* ollamaTokens(prompt: string): AsyncGenerator<string> {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    }),
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
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
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
  const connection = await openExampleNatsConnection();
  let service: AgentService | undefined;

  try {
    // Identity and heartbeat cadence are env-overridable (see 01-echo.ts).
    const heartbeatIntervalS = Number(process.env["NATS_AGENT_HEARTBEAT_INTERVAL"]) || undefined;
    service = new AgentService({
      nc: connection.nc,
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
      ...(connection.signer ? { identity: { signer: connection.signer } } : {}),
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
  console.error("ollama agent failed:", err);
  process.exit(1);
});

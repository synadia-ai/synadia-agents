// llm.ts — a tiny streaming chat client that targets EITHER a local Ollama or
// OpenRouter, chosen automatically from the environment.
//
// This is the "reusable base" behind `04-combined.ts`: it reduces both backends
// to a single chat shape, so the agent — and any future tool-calling — looks the
// same regardless of provider. Keep it small and dependency-free (just `fetch`).
//
//   OPENROUTER_API_KEY set?  → OpenRouter   (OPENROUTER_MODEL, default openai/gpt-4o-mini)
//   otherwise                → local Ollama (OLLAMA_MODEL, default llama3.2; OLLAMA_URL)

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LlmClient {
  /** Human-readable "backend/model", handy for logging. */
  readonly label: string;
  /** Stream the assistant's reply to `messages`, yielding text as it arrives. */
  chatStream(messages: ChatMessage[]): AsyncGenerator<string>;
}

/** Pick a backend from the environment: OpenRouter if a key is present, else Ollama. */
export function createLlmClient(): LlmClient {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  return apiKey ? openRouter(apiKey) : ollama();
}

// --- Ollama (local) ---------------------------------------------------------
function ollama(): LlmClient {
  const url = process.env["OLLAMA_URL"] ?? "http://localhost:11434";
  const model = process.env["OLLAMA_MODEL"] ?? "llama3.2";
  return {
    label: `ollama/${model}`,
    async *chatStream(messages) {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, stream: true }),
      });
      if (!res.ok || res.body === null) {
        throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
      }
      // /api/chat returns newline-delimited JSON, each line `{message:{content}}`.
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const bytes of res.body) {
        buffer += decoder.decode(bytes as Uint8Array, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") continue;
          // Tolerate a rare malformed line instead of throwing out of the
          // generator (same guard as the OpenRouter branch and 05-tools.ts).
          try {
            const token =
              (JSON.parse(line) as { message?: { content?: string } }).message?.content ?? "";
            if (token) yield token;
          } catch {
            /* skip malformed line */
          }
        }
      }
    },
  };
}

// --- OpenRouter (hosted, OpenAI-compatible) ---------------------------------
function openRouter(apiKey: string): LlmClient {
  const model = process.env["OPENROUTER_MODEL"] ?? "openai/gpt-4o-mini";
  return {
    label: `openrouter/${model}`,
    async *chatStream(messages) {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages, stream: true }),
      });
      if (!res.ok || res.body === null) {
        throw new Error(`OpenRouter request failed: ${res.status} ${res.statusText}`);
      }
      // OpenAI SSE: `data: {json}` lines (+ keep-alive comments), then `data: [DONE]`.
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const bytes of res.body) {
        buffer += decoder.decode(bytes as Uint8Array, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "" || data === "[DONE]") continue;
          try {
            const token =
              (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]
                ?.delta?.content ?? "";
            if (token) yield token;
          } catch {
            /* ignore the rare non-JSON keep-alive line */
          }
        }
      }
    },
  };
}

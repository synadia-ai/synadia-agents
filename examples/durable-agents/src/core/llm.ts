// core/llm.ts — an OpenAI-shaped chat client, structured for DURABLE execution.
//
// The agent loop (see effects.ts) owns the agentic while-loop, so this client does NOT loop. It
// exposes a single, awaitable, NON-streaming turn — `decide(messages, tools) → { content, toolCalls }`
// — because a durable step journals a VALUE, not a live stream: replay returns the recorded turn
// instead of re-calling (and re-billing) the model. (Token streaming, when you want it, is a
// separate best-effort channel in the non-durable front-door; it never rides the journal.)
//
// Backend, by env (offline stub by default so crash-replay demos are deterministic):
//   OPENROUTER_API_KEY set   → OpenRouter (OPENROUTER_MODEL, default openai/gpt-4o-mini)
//   LLM_BACKEND=ollama       → local Ollama (OLLAMA_URL / OLLAMA_MODEL, default llama3.1:8b)
//   otherwise                → a deterministic scripted stub (each agent supplies its own script)

/** A tool as advertised to the model (JSON-Schema params). Execution lives in the workflow. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
/** One tool invocation the model asked for. `id` correlates the result back. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
/** One model turn. Empty `toolCalls` ⇒ the model is done and `content` is the final answer. */
export interface Decision {
  content: string;
  toolCalls: ToolCall[];
}
/** The running transcript — plain JSON so every entry round-trips a durable journal. */
export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export interface LlmClient {
  readonly label: string;
  decide(messages: ChatMessage[], tools: ToolSpec[]): Promise<Decision>;
}

/** A deterministic offline brain — a pure function of the transcript so far, for reproducible demos. */
export interface StubScript {
  readonly label?: string;
  decide(messages: ChatMessage[], tools: ToolSpec[]): Decision;
}

export function createLlm(opts: { stub?: StubScript } = {}): LlmClient {
  const key = process.env.OPENROUTER_API_KEY;
  const backend = process.env.LLM_BACKEND;
  if (backend === "openrouter" || (backend === undefined && key)) {
    if (!key) throw new Error("LLM_BACKEND=openrouter but OPENROUTER_API_KEY is unset");
    return openRouter(key);
  }
  if (backend === "ollama") return ollama();
  if (opts.stub) return stub(opts.stub);
  throw new Error("no LLM backend: set OPENROUTER_API_KEY, or LLM_BACKEND=ollama, or pass a stub");
}

function stub(script: StubScript): LlmClient {
  return {
    label: script.label ?? "stub",
    decide: (messages, tools) => Promise.resolve(script.decide(messages, tools)),
  };
}

// ── OpenAI-compatible wire helpers (shared by OpenRouter + Ollama) ──────────────────────────────
function toolSchema(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function wireMessages(messages: ChatMessage[], withIds: boolean): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return withIds
        ? { role: "tool", content: m.content, tool_call_id: m.toolCallId }
        : { role: "tool", content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const tool_calls = m.toolCalls.map((c) =>
        withIds
          ? { id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }
          : { function: { name: c.name, arguments: c.args } },
      );
      return { role: m.role, content: m.content, tool_calls };
    }
    return { role: m.role, content: m.content };
  });
}

let synthId = 0;
function asArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw || "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (raw as Record<string, unknown> | undefined) ?? {};
}

// ── OpenRouter (OpenAI-compatible, hosted) ──────────────────────────────────────────────────────
interface OpenAiMessage {
  content?: string;
  tool_calls?: { id?: string; function: { name: string; arguments: string } }[];
}

function openRouter(apiKey: string): LlmClient {
  const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  return {
    label: `openrouter/${model}`,
    async decide(messages, tools) {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages: wireMessages(messages, true), tools: toolSchema(tools), stream: false }),
      });
      if (!res.ok) throw new Error(`OpenRouter failed: ${res.status} ${res.statusText}`);
      const json = (await res.json()) as { choices?: { message?: OpenAiMessage }[] };
      const msg = json.choices?.[0]?.message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((c) => ({
        id: c.id ?? `call_${synthId++}`,
        name: c.function.name,
        args: asArgs(c.function.arguments),
      }));
      return { content: msg.content ?? "", toolCalls };
    },
  };
}

// ── Ollama (local; tool_calls carry object args and no ids) ──────────────────────────────────────
interface OllamaMessage {
  content?: string;
  tool_calls?: { function: { name: string; arguments?: Record<string, unknown> } }[];
}

function ollama(): LlmClient {
  const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL ?? "llama3.1:8b";
  return {
    label: `ollama/${model}`,
    async decide(messages, tools) {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: wireMessages(messages, false), tools: toolSchema(tools), stream: false }),
      });
      if (!res.ok) throw new Error(`Ollama failed: ${res.status} ${res.statusText}`);
      const msg = ((await res.json()) as { message?: OllamaMessage }).message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((c) => ({
        id: `call_${synthId++}`,
        name: c.function.name,
        args: c.function.arguments ?? {},
      }));
      return { content: msg.content ?? "", toolCalls };
    },
  };
}

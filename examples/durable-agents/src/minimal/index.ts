// Track 1 — the smallest possible DURABLE agent.
//
// This is an ordinary tool-calling agent loop. The ONLY thing that makes it durable is that each
// model turn and each tool call is wrapped in `yield* ctx.run(...)` — a Resonate durable step.
// Nothing else: no abstraction, no framework glue. That wrap is the whole trick:
//
//   • the model call is journaled once  → after a crash it REPLAYS (the model is never re-called
//     and never re-billed);
//   • the tool call is journaled once    → its side effect never re-fires on replay.
//
// Run it:  bun run src/minimal/index.ts
// It uses Resonate's in-memory server so it needs no infrastructure. Point Resonate at a real
// server / NATS (see the SRE example) to get durability that survives an actual process restart.

import { Resonate, type Context } from "@resonatehq/sdk";

// ── a tiny agent's world: one deterministic stub "model" + one tool ────────────────────────────
type ToolCall = { id: string; name: string; args: Record<string, unknown> };
type Msg = { role: string; content: string; toolCalls?: ToolCall[]; toolCallId?: string };

const tools: Record<string, (args: any) => Promise<string>> = {
  async get_weather({ city }: { city: string }) {
    // pretend this is a real (paid, side-effecting) API call
    return `${city}: 21°C, clear`;
  },
};

// A deterministic stand-in for an LLM: call the weather tool once, then answer. (Swap this for a
// real OpenAI/OpenRouter/Ollama call — it changes nothing about the durability story below.)
async function callModel(messages: Msg[]): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const usedTool = messages.some((m) => m.role === "tool");
  if (!usedTool) {
    return { content: "Let me check the weather.", toolCalls: [{ id: "c0", name: "get_weather", args: { city: "Berlin" } }] };
  }
  const observation = messages.find((m) => m.role === "tool")?.content ?? "";
  return { content: `Here you go — ${observation}.`, toolCalls: [] };
}

// ── THE DURABLE AGENT ──────────────────────────────────────────────────────────────────────────
// A normal agent loop. Look at how little is Resonate-specific: two `yield* ctx.run(...)` wraps.
function* weatherAgent(ctx: Context, prompt: string): Generator<any, string, any> {
  const messages: Msg[] = [{ role: "user", content: prompt }];

  for (let step = 0; step < 6; step++) {
    // (1) REASON — durable step: journaled once, replayed verbatim after a crash (never re-billed).
    const decision = yield* ctx.run(() => callModel(messages));
    messages.push({ role: "assistant", content: decision.content, toolCalls: decision.toolCalls });

    if (decision.toolCalls.length === 0) return decision.content; // no tools → the model is done

    // (2) ACT — each tool call is a durable step: its side effect fires once, never twice on replay.
    for (const call of decision.toolCalls) {
      const tool = tools[call.name];
      const result = tool ? yield* ctx.run(() => tool(call.args)) : `unknown tool ${call.name}`;
      messages.push({ role: "tool", content: String(result), toolCallId: call.id });
    }
  }
  return "(gave up after too many steps)";
}

// ── run it ───────────────────────────────────────────────────────────────────────────────────--
const resonate = new Resonate(); // no url ⇒ in-memory server (no NATS needed for this demo)
resonate.register("weather-agent", weatherAgent);

const answer = await resonate.run("weather-run-1", "weather-agent", "what's the weather in Berlin?");
console.log("🧠 agent answer:", answer);

await resonate.stop();

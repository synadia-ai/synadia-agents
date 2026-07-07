// core/effects.ts — the ENGINE-NEUTRAL agent core (Track 2).
//
// The agent loop is written ONCE, here, as a generator that YIELDS descriptors of the only two
// durable ops an agent needs — a `step` (LLM call / tool call) and a `signal` (human approval) —
// and receives their results back. It has ZERO dependency on any durable-execution engine. A
// per-engine "driver" interprets the effects (see resonate.ts). To add another DE framework later,
// write one more ~15-line driver — the agent itself never changes.
import type { ChatMessage, Decision, LlmClient, ToolCall, ToolSpec } from "./llm";

/** A tool the agent can call: how it's advertised, how it runs, whether it needs approval. */
export interface Tool {
  spec: ToolSpec;
  /** `key` is the durable step's stable idempotency key — pass it to the real side effect. */
  run: (args: Record<string, unknown>, key: string) => Promise<string>;
  /** If true, the loop parks on a human-approval `signal` before running the tool. */
  dangerous?: boolean;
}

export interface AgentConfig {
  llm: LlmClient;
  system: string;
  prompt: string;
  tools: Tool[];
  maxSteps?: number;
  approvalTimeoutMs?: number;
}
export interface AgentResult {
  answer: string;
  steps: number;
}

/** The two durable ops an agent loop needs, as engine-neutral descriptors. */
export type Effect =
  | { t: "step"; name: string; run: (key: string) => Promise<unknown> }
  | { t: "signal"; name: string; timeoutMs?: number; ask?: unknown };

const toolMsg = (call: ToolCall, content: string): ChatMessage => ({
  role: "tool",
  content,
  toolCallId: call.id,
  name: call.name,
});

/**
 * THE ENGINE-NEUTRAL LOOP. It only ever advances on values fed back from durable ops, so on replay
 * it re-yields the identical sequence of effects — which is exactly what makes it replay-safe on any
 * engine. The one rule: no raw nondeterminism (Date.now/Math.random/IO) between yields.
 */
export function* agentLoop(cfg: AgentConfig): Generator<Effect, AgentResult, any> {
  const maxSteps = cfg.maxSteps ?? 8;
  const specs = cfg.tools.map((t) => t.spec);
  const byName = new Map(cfg.tools.map((t) => [t.spec.name, t] as const));
  const messages: ChatMessage[] = [
    { role: "system", content: cfg.system },
    { role: "user", content: cfg.prompt },
  ];

  for (let step = 0; step < maxSteps; step++) {
    // REASON — a durable step. Journaled once; replayed (never re-called) after a crash.
    const decision: Decision = yield { t: "step", name: `llm-${step}`, run: () => cfg.llm.decide(messages, specs) };
    messages.push(
      decision.toolCalls.length > 0
        ? { role: "assistant", content: decision.content, toolCalls: decision.toolCalls }
        : { role: "assistant", content: decision.content },
    );
    if (decision.toolCalls.length === 0) return { answer: decision.content, steps: step };

    // ACT — each tool is a durable step; a dangerous tool parks on a human-approval signal first.
    for (const [i, call] of decision.toolCalls.entries()) {
      const tool = byName.get(call.name);
      if (!tool) {
        messages.push(toolMsg(call, `error: unknown tool '${call.name}'`));
        continue;
      }
      if (tool.dangerous) {
        const verdict: { approved: boolean } = yield {
          t: "signal",
          name: `approve-${step}-${i}`,
          timeoutMs: cfg.approvalTimeoutMs,
          ask: { name: call.name, args: call.args },
        };
        if (!verdict.approved) {
          messages.push(toolMsg(call, "✗ denied by human"));
          continue;
        }
      }
      const out = (yield {
        t: "step",
        name: `tool-${step}-${i}`,
        run: (key) => tool.run(call.args, key),
      }) as string;
      messages.push(toolMsg(call, out));
    }
  }
  return { answer: `stopped after ${maxSteps} steps`, steps: maxSteps };
}

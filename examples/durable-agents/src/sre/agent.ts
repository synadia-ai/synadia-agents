// sre/agent.ts — the SRE persona: tools + system prompt + a deterministic offline script.
// Shared by both the offline smoke (index.ts) and the real NATS serve mode (serve.ts).
import type { Tool } from "../core/effects";
import type { ChatMessage, Decision, StubScript, ToolSpec } from "../core/llm";

export const sreSystem =
  "You are a careful SRE assistant. Investigate first with read-only tools, then act. " +
  "Restarting a service is disruptive and requires human approval. When the incident is resolved, " +
  "send a notification and give a short final summary.";

/** The three SRE tools. `onCall` lets a caller observe/count executions (for the exactly-once proof). */
export function sreTools(onCall?: (name: string, args: Record<string, unknown>, key: string) => void): Tool[] {
  const hit = (name: string, args: Record<string, unknown>, key: string) => onCall?.(name, args, key);
  return [
    {
      spec: {
        name: "get_metrics",
        description: "read a service's current key metrics",
        parameters: { type: "object", properties: { service: { type: "string" } }, required: ["service"] },
      },
      run: async (args, key) => {
        hit("get_metrics", args, key);
        return `service=${String(args.service)} p99=1240ms error_rate=6.1% saturation=0.92 (UNHEALTHY)`;
      },
    },
    {
      spec: {
        name: "restart_service",
        description: "restart a service (disruptive)",
        parameters: { type: "object", properties: { service: { type: "string" } }, required: ["service"] },
      },
      dangerous: true, // parks on human approval before running
      run: async (args, key) => {
        hit("restart_service", args, key);
        return `restarted ${String(args.service)}; new pods healthy (idempotencyKey=${key})`;
      },
    },
    {
      spec: {
        name: "send_notification",
        description: "post a message to the on-call channel",
        parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      },
      run: async (args, key) => {
        hit("send_notification", args, key);
        return "delivered to #ops";
      },
    },
  ];
}

/** Deterministic offline playbook: metrics → restart (approval) → notify → done. */
export const sreStub: StubScript = {
  label: "sre-stub",
  decide(messages: ChatMessage[], _tools: ToolSpec[]): Decision {
    const seen = messages.filter((m) => m.role === "tool").length;
    if (seen === 0)
      return { content: "Checkout is slow — pulling metrics.", toolCalls: [{ id: "t0", name: "get_metrics", args: { service: "checkout" } }] };
    if (seen === 1)
      return { content: "Metrics are unhealthy — I'll restart checkout (needs approval).", toolCalls: [{ id: "t1", name: "restart_service", args: { service: "checkout" } }] };
    if (seen === 2)
      return { content: "Restarted — notifying on-call.", toolCalls: [{ id: "t2", name: "send_notification", args: { message: "checkout restarted; metrics recovering" } }] };
    return { content: "Done: checkout was unhealthy, I restarted it (with approval) and metrics are recovering.", toolCalls: [] };
  },
};

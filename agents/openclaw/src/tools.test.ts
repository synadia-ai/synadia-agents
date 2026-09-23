// The agent tools in OpenClaw: the `agentTools` setting, the subset each
// mode offers, and the SDK helper's definitions as OpenClaw tools (see
// `tools.ts`). The helper is built over a client that never connects; no
// NATS is needed.

import { describe, expect, it } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  AGENT_TOOL_NAMES,
  Agents,
  AgentTools,
  BLOCKING_AGENT_TOOLS,
  type AgentToolCallOptions,
  type AgentToolResult,
} from "@synadia-ai/agents";
import type { NatsConnection } from "@nats-io/nats-core";
import type { ServedRequest } from "./extensions.js";
import {
  AGENT_TOOLS_VAR,
  parseAgentToolsMode,
  registerAgentTools,
  toolLabel,
  toolNamesFor,
  type ActiveTurn,
} from "./tools.js";

// The helper only stores the client until a tool call needs the bus.
const offlineAgents = new Agents({ nc: {} as unknown as NatsConnection });

const passthrough = {
  activeTurn: () => undefined,
  aroundToolCall: <T>(_r: ServedRequest | undefined, _n: string, run: () => T) => run(),
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("no text content");
  return JSON.parse(first.text ?? "");
}

describe("parseAgentToolsMode", () => {
  it("defaults to the blocking three", () => {
    expect(parseAgentToolsMode(undefined, "x")).toBe("blocking");
    expect(parseAgentToolsMode("", "x")).toBe("blocking");
  });

  it("names the three modes", () => {
    expect(parseAgentToolsMode("blocking", "x")).toBe("blocking");
    expect(parseAgentToolsMode("all", "x")).toBe("all");
    expect(parseAgentToolsMode("off", "x")).toBe("off");
  });

  it("an unknown mode fails, naming the setting", () => {
    expect(() => parseAgentToolsMode("some", AGENT_TOOLS_VAR)).toThrow(
      /NATS_AGENT_TOOLS must be one of blocking, all, off; got "some"/,
    );
    expect(() => parseAgentToolsMode(3, "channels.nats.accounts.default.agentTools")).toThrow(
      /channels.nats.accounts.default.agentTools must be one of .*; got 3/,
    );
  });
});

describe("toolNamesFor and toolLabel", () => {
  it("blocking is the SDK's three, all is the six, off is none", () => {
    expect(toolNamesFor("blocking")).toBe(BLOCKING_AGENT_TOOLS);
    expect(toolNamesFor("all")).toBe(AGENT_TOOL_NAMES);
    expect(toolNamesFor("off")).toBeUndefined();
  });

  it("labels read as words", () => {
    expect(toolLabel("discover_agents")).toBe("Discover agents");
    expect(toolLabel("list_agent_calls")).toBe("List agent calls");
  });
});

describe("registerAgentTools", () => {
  it("blocking gives the three by name, with the helper's words and schema as they are", () => {
    const tools = new AgentTools({ agents: offlineAgents, tools: BLOCKING_AGENT_TOOLS });
    const registered = registerAgentTools(tools, passthrough);
    expect(registered.map((t) => t.name)).toEqual([
      "discover_agents",
      "prompt_agent",
      "answer_agent",
    ]);
    for (const definition of tools.definitions) {
      const tool = registered.find((t) => t.name === definition.name)!;
      expect(tool.description).toBe(definition.description);
      // The JSON Schema object itself, no TypeBox wrapper.
      expect(tool.parameters).toBe(definition.parameters as never);
      expect((tool.parameters as { type?: string }).type).toBe("object");
      expect(tool.label).toBe(toolLabel(definition.name));
    }
    // The blocking set has no `wait` parameter.
    const prompt = registered.find((t) => t.name === "prompt_agent")!.parameters as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(prompt.properties)).not.toContain("wait");
  });

  it("all gives the six; off gives none because no helper is made", () => {
    const tools = new AgentTools({ agents: offlineAgents, tools: AGENT_TOOL_NAMES });
    expect(registerAgentTools(tools, passthrough).map((t) => t.name)).toEqual([
      ...AGENT_TOOL_NAMES,
    ]);
    expect(toolNamesFor("off")).toBeUndefined();
  });

  it("the helper keeps the agent's own address, so the model cannot prompt the OpenClaw it runs in", async () => {
    const self = "agents.prompt.oc.acme.echo";
    const tools = new AgentTools({
      agents: offlineAgents,
      tools: BLOCKING_AGENT_TOOLS,
      selfAddress: self,
    });
    const registered = registerAgentTools(tools, passthrough);
    const result = await registered
      .find((t) => t.name === "prompt_agent")!
      .execute("call-1", { address: self, prompt: "hi" });
    expect((textOf(result) as { error?: string }).error).toMatch(/your own address/);
  });

  it("execute passes the tool-call id and signal, runs inside aroundToolCall with the active request, in that request's context, and returns JSON text", async () => {
    const als = new AsyncLocalStorage<string>();
    const calls: Array<{
      name: string;
      args: unknown;
      options: AgentToolCallOptions;
      store: string | undefined;
    }> = [];
    const fakeTools = {
      definitions: new AgentTools({ agents: offlineAgents, tools: BLOCKING_AGENT_TOOLS })
        .definitions,
      async execute(
        name: string,
        args?: unknown,
        options: AgentToolCallOptions = {},
      ): Promise<AgentToolResult> {
        calls.push({ name, args, options, store: als.getStore() });
        return { call_id: "c1", state: "done", reply: "ok" };
      },
    };
    const served: ServedRequest = { id: "42", extras: {} };
    // The turn's `enter` is the request's async context, as the gateway
    // captured it in the prompt handler.
    const turn: ActiveTurn = {
      served,
      enter: als.run.bind(als, "request:42") as ActiveTurn["enter"],
    };
    const wrapped: Array<[string | undefined, string, string | undefined]> = [];
    const registered = registerAgentTools(fakeTools, {
      activeTurn: () => turn,
      aroundToolCall: (r, name, run) => {
        wrapped.push([r?.id, name, als.getStore()]);
        return run();
      },
    });
    const controller = new AbortController();
    const result = await registered
      .find((t) => t.name === "discover_agents")!
      .execute("call-9", { agent: "pi" }, controller.signal);
    expect(calls).toEqual([
      {
        name: "discover_agents",
        args: { agent: "pi" },
        options: { toolCallId: "call-9", signal: controller.signal },
        store: "request:42",
      },
    ]);
    // The wrapper runs in the request's context too.
    expect(wrapped).toEqual([["42", "discover_agents", "request:42"]]);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ call_id: "c1", state: "done", reply: "ok" }) },
    ]);
    expect(result.details).toEqual({ call_id: "c1", state: "done", reply: "ok" });

    // No signal: none is passed.
    await registered.find((t) => t.name === "answer_agent")!.execute("call-10", {});
    expect(calls[1]!.options).toEqual({ toolCallId: "call-10" });
  });

  it("without an active turn the wrapper gets no request and the call runs where it is", async () => {
    const seen: Array<string | undefined> = [];
    const fakeTools = {
      definitions: new AgentTools({ agents: offlineAgents, tools: BLOCKING_AGENT_TOOLS })
        .definitions,
      async execute(): Promise<AgentToolResult> {
        return { ok: true };
      },
    };
    const registered = registerAgentTools(fakeTools, {
      activeTurn: () => undefined,
      aroundToolCall: (r, _name, run) => {
        seen.push(r?.id);
        return run();
      },
    });
    const result = await registered[0]!.execute("call-1", {});
    expect(seen).toEqual([undefined]);
    expect(textOf(result)).toEqual({ ok: true });
  });
});

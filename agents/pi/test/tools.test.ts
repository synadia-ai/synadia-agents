// The agent tools in PI: the `agentTools` setting, the subset each mode
// offers, and the registration of the SDK helper's definitions with PI's
// `registerTool` (see `extensions/tools.ts`). The helper is built over a
// client that never connects; no NATS is needed.
//
// Run with: bun test test/tools.test.ts

import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	AGENT_TOOL_NAMES,
	Agents,
	AgentTools,
	BLOCKING_AGENT_TOOLS,
	type AgentToolCallOptions,
	type AgentToolResult,
} from "@synadia-ai/agents";
import type { NatsConnection } from "@nats-io/transport-node";
import type { ServedRequest } from "../extensions/extensions.ts";
import {
	AGENT_TOOLS_VAR,
	registerAgentTools,
	resolveAgentToolsMode,
	toolLabel,
	toolNamesFor,
} from "../extensions/tools.ts";

type Registered = Parameters<Parameters<typeof registerAgentTools>[0]["registerTool"]>[0];

function fakePi(): { registered: Map<string, Registered>; registerTool: (t: Registered) => void } {
	const registered = new Map<string, Registered>();
	return { registered, registerTool: (t) => registered.set(t.name, t) };
}

// The helper only stores the client until a tool call needs the bus.
const offlineAgents = new Agents({ nc: {} as unknown as NatsConnection });

describe("resolveAgentToolsMode", () => {
	test("defaults to the blocking three", () => {
		expect(resolveAgentToolsMode({}, {})).toBe("blocking");
		expect(resolveAgentToolsMode({ agentTools: undefined }, {})).toBe("blocking");
	});

	test("the config field selects the mode", () => {
		expect(resolveAgentToolsMode({ agentTools: "all" }, {})).toBe("all");
		expect(resolveAgentToolsMode({ agentTools: "off" }, {})).toBe("off");
	});

	test("NATS_AGENT_TOOLS wins over the config field; empty means the default", () => {
		expect(resolveAgentToolsMode({ agentTools: "all" }, { [AGENT_TOOLS_VAR]: "off" })).toBe("off");
		expect(resolveAgentToolsMode({ agentTools: "all" }, { [AGENT_TOOLS_VAR]: "" })).toBe("blocking");
	});

	test("an unknown mode fails before the connection, naming the setting", () => {
		expect(() => resolveAgentToolsMode({}, { [AGENT_TOOLS_VAR]: "some" })).toThrow(
			/NATS_AGENT_TOOLS\/agentTools must be one of blocking, all, off/,
		);
		expect(() => resolveAgentToolsMode({ agentTools: 3 }, {})).toThrow(/got 3/);
	});
});

describe("toolNamesFor and toolLabel", () => {
	test("blocking is the SDK's three, all is the six, off is none", () => {
		expect(toolNamesFor("blocking")).toBe(BLOCKING_AGENT_TOOLS);
		expect(toolNamesFor("all")).toBe(AGENT_TOOL_NAMES);
		expect(toolNamesFor("off")).toBeUndefined();
	});

	test("labels read as words", () => {
		expect(toolLabel("discover_agents")).toBe("Discover agents");
		expect(toolLabel("list_agent_calls")).toBe("List agent calls");
	});
});

describe("registerAgentTools", () => {
	const hooks = {
		activeRequest: () => undefined,
		aroundToolCall: <T>(_r: ServedRequest | undefined, _n: string, run: () => T) => run(),
	};

	test("blocking registers the three by name, with the helper's words and schema as they are", () => {
		const pi = fakePi();
		const tools = new AgentTools({ agents: offlineAgents, tools: BLOCKING_AGENT_TOOLS });
		expect(registerAgentTools(pi, tools, hooks)).toEqual([
			"discover_agents",
			"prompt_agent",
			"answer_agent",
		]);
		expect([...pi.registered.keys()]).toEqual(["discover_agents", "prompt_agent", "answer_agent"]);
		for (const definition of tools.definitions) {
			const registered = pi.registered.get(definition.name)!;
			expect(registered.description).toBe(definition.description);
			// The JSON Schema object itself, not a TypeBox wrapper.
			expect(registered.parameters).toBe(definition.parameters as never);
			expect((registered.parameters as { type?: string }).type).toBe("object");
			expect(registered.label).toBe(toolLabel(definition.name));
		}
		// The blocking set has no `wait` parameter.
		const prompt = pi.registered.get("prompt_agent")!.parameters as { properties: Record<string, unknown> };
		expect(Object.keys(prompt.properties)).not.toContain("wait");
	});

	test("all registers the six; off registers none because no helper is made", () => {
		const pi = fakePi();
		const tools = new AgentTools({ agents: offlineAgents, tools: AGENT_TOOL_NAMES });
		expect(registerAgentTools(pi, tools, hooks)).toEqual([...AGENT_TOOL_NAMES]);
		expect(pi.registered.size).toBe(6);
		expect(toolNamesFor("off")).toBeUndefined();
	});

	test("the helper keeps PI's own address, so the model cannot prompt the PI it runs in", async () => {
		const pi = fakePi();
		const self = "agents.prompt.pi.me.here";
		const tools = new AgentTools({ agents: offlineAgents, tools: BLOCKING_AGENT_TOOLS, selfAddress: self });
		registerAgentTools(pi, tools, hooks);
		const result = await pi.registered
			.get("prompt_agent")!
			.execute("call-1", { address: self, prompt: "hi" }, undefined, undefined, {} as never);
		const parsed = JSON.parse((result.content[0] as { text: string }).text) as { error?: string };
		expect(parsed.error).toMatch(/your own address/);
	});

	test("execute passes the tool-call id and signal, runs inside aroundToolCall with the active request, and returns JSON text", async () => {
		const pi = fakePi();
		const als = new AsyncLocalStorage<string>();
		const calls: Array<{ name: string; args: unknown; options: AgentToolCallOptions; store: string | undefined }> = [];
		const fakeTools = {
			definitions: new AgentTools({ agents: offlineAgents, tools: BLOCKING_AGENT_TOOLS }).definitions,
			async execute(name: string, args?: unknown, options: AgentToolCallOptions = {}): Promise<AgentToolResult> {
				calls.push({ name, args, options, store: als.getStore() });
				return { call_id: "c1", state: "done", reply: "ok" };
			},
		};
		const served: ServedRequest = { id: "42", extras: {} };
		const wrapped: Array<[string | undefined, string]> = [];
		registerAgentTools(pi, fakeTools, {
			activeRequest: () => served,
			aroundToolCall: (r, name, run) => {
				wrapped.push([r?.id, name]);
				return als.run(`in:${r?.id}`, run);
			},
		});
		const controller = new AbortController();
		const result = await pi.registered
			.get("discover_agents")!
			.execute("call-9", { agent: "pi" }, controller.signal, undefined, {} as never);
		expect(calls).toEqual([
			{
				name: "discover_agents",
				args: { agent: "pi" },
				options: { toolCallId: "call-9", signal: controller.signal },
				store: "in:42",
			},
		]);
		expect(wrapped).toEqual([["42", "discover_agents"]]);
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify({ call_id: "c1", state: "done", reply: "ok" }) },
		]);
		expect(result.details).toEqual({ call_id: "c1", state: "done", reply: "ok" });

		// No signal: none is passed.
		await pi.registered.get("answer_agent")!.execute("call-10", {}, undefined, undefined, {} as never);
		expect(calls[1]!.options).toEqual({ toolCallId: "call-10" });
	});
});

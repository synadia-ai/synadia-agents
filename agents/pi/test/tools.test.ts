// The agent tools in PI: the `agentTools` setting, the subset each mode
// offers, and the registration of the SDK helper's definitions with PI's
// `registerTool` (see `extensions/tools.ts`), with the lines they add to
// PI's system prompt, read back from a session of the installed PI. The
// helper is built over a client that never connects; no NATS is needed.
//
// Run with: bun test test/tools.test.ts

import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_TOOL_NAMES,
	Agents,
	AgentTools,
	BLOCKING_AGENT_TOOLS,
	type AgentToolCallOptions,
	type AgentToolResult,
} from "@synadia-ai/agents";
import type { NatsConnection } from "@nats-io/transport-node";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { LocalTurn, ServedRequest } from "../extensions/extensions.ts";
import {
	AGENT_TOOL_SNIPPETS,
	AGENT_TOOLS_VAR,
	agentToolGuidelines,
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
		address: "agents.prompt.pi.me.here",
		activeRequest: () => undefined,
		aroundToolCall: <T>(_r: ServedRequest | LocalTurn | undefined, _n: string, run: () => T) => run(),
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
			address: hooks.address,
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

	test("a call in a local turn runs inside aroundToolCall with that turn, read at the call", async () => {
		const pi = fakePi();
		const fakeTools = {
			definitions: new AgentTools({ agents: offlineAgents, tools: BLOCKING_AGENT_TOOLS }).definitions,
			async execute(): Promise<AgentToolResult> {
				return { call_id: "c2", state: "done", reply: "ok" };
			},
		};
		const turn: LocalTurn = { id: "local-3", local: true };
		let current: ServedRequest | LocalTurn | undefined = turn;
		const wrapped: Array<[string | undefined, boolean, string]> = [];
		registerAgentTools(pi, fakeTools, {
			address: hooks.address,
			activeRequest: () => current,
			aroundToolCall: (r, name, run) => {
				wrapped.push([r?.id, r !== undefined && "local" in r, name]);
				return run();
			},
		});
		await pi.registered.get("prompt_agent")!.execute("call-11", {}, undefined, undefined, {} as never);
		current = undefined;
		await pi.registered.get("prompt_agent")!.execute("call-12", {}, undefined, undefined, {} as never);
		expect(wrapped).toEqual([
			["local-3", true, "prompt_agent"],
			[undefined, false, "prompt_agent"],
		]);
	});
});

describe("PI's system prompt", () => {
	// A name the channel found taken registers with a suffix: the address
	// named is the one the session registered at.
	const address = "agents.prompt.pi.me.here-2";
	const hooks = {
		address,
		activeRequest: () => undefined,
		aroundToolCall: <T>(_r: ServedRequest | LocalTurn | undefined, _n: string, run: () => T) => run(),
	};
	const everyTool = () => new AgentTools({ agents: offlineAgents, tools: AGENT_TOOL_NAMES });

	test("every tool carries a one-line snippet", () => {
		const pi = fakePi();
		registerAgentTools(pi, everyTool(), hooks);
		expect(pi.registered.size).toBe(6);
		for (const name of AGENT_TOOL_NAMES) {
			const snippet = pi.registered.get(name)!.promptSnippet;
			expect(snippet).toBe(AGENT_TOOL_SNIPPETS[name]);
			expect(snippet!.length).toBeGreaterThan(0);
			expect(snippet).not.toMatch(/\n/);
		}
	});

	test("every tool's guidelines name the address it was given; discover_agents and prompt_agent add their own", () => {
		const pi = fakePi();
		registerAgentTools(pi, everyTool(), hooks);
		const own = `Other agents reach you at ${address}. To reach other agents, use discover_agents and prompt_agent, not shell commands.`;
		for (const name of AGENT_TOOL_NAMES) {
			const guidelines = pi.registered.get(name)!.promptGuidelines!;
			expect(guidelines[0]).toBe(own);
			expect(guidelines).toEqual(agentToolGuidelines(name, address));
		}
		expect(pi.registered.get("discover_agents")!.promptGuidelines).toEqual([
			own,
			"Call discover_agents with no arguments to list every agent. Its filters match the agent, owner and name it lists for each entry, exactly: no wildcards, never an address.",
		]);
		expect(pi.registered.get("prompt_agent")!.promptGuidelines).toEqual([
			own,
			"Pass prompt_agent the address exactly as discover_agents returned it, and make the prompt self-contained.",
		]);
		expect(pi.registered.get("answer_agent")!.promptGuidelines).toEqual([own]);
	});

	test("registered again with another address, every tool names only the new one", () => {
		const pi = fakePi();
		const tools = everyTool();
		registerAgentTools(pi, tools, { ...hooks, address: "agents.prompt.pi.me.here" });
		registerAgentTools(pi, tools, hooks);
		expect(pi.registered.size).toBe(6);
		for (const registered of pi.registered.values()) {
			const text = registered.promptGuidelines!.join("\n");
			expect(text).toContain(`reach you at ${address}.`);
			expect(text).not.toContain("reach you at agents.prompt.pi.me.here.");
		}
	});

	test("the words name only the tools and the address: no product, service or other address", () => {
		const texts = [
			...Object.values(AGENT_TOOL_SNIPPETS),
			...AGENT_TOOL_NAMES.flatMap((name) => agentToolGuidelines(name, address)),
		].map((text) => text.replaceAll(address, "ADDRESS"));
		const toolNames = new Set<string>(AGENT_TOOL_NAMES);
		for (const text of texts) {
			// Every name with an underscore is one of the tools.
			for (const word of text.match(/\w+_\w+/g) ?? []) expect(toolNames.has(word)).toBe(true);
			// A capital letter only where a sentence starts, so no proper name.
			const rest = text.replace(/(^|\. )[A-Z]/g, "$1").replace(/ADDRESS/g, "");
			expect(rest).not.toMatch(/[A-Z]/);
			// No dot but a sentence's end: no other address, host or link.
			expect(rest).not.toMatch(/\.\S/);
		}
	});

	test("PI lists every tool, names the address once, and replaces it when the tools are registered again", async () => {
		// A session of the installed PI, with nothing discovered from disk:
		// the tools are registered after the session is bound, as the
		// channel registers them once on the bus.
		const dir = mkdtempSync(join(tmpdir(), "pi-tools-prompt-"));
		try {
			let api: ExtensionAPI | undefined;
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd: dir,
				agentDir: dir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					(pi) => {
						api = pi;
					},
				],
			});
			await resourceLoader.reload();
			const modelRuntime = await ModelRuntime.create({
				authPath: join(dir, "auth.json"),
				modelsPath: join(dir, "models.json"),
			});
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				resourceLoader,
				settingsManager,
				modelRuntime,
				sessionManager: SessionManager.inMemory(dir),
			});
			try {
				expect(session.systemPrompt).not.toContain("discover_agents");
				const tools = new AgentTools({ agents: offlineAgents, tools: BLOCKING_AGENT_TOOLS });
				registerAgentTools(api!, tools, { ...hooks, address: "agents.prompt.pi.me.here" });
				registerAgentTools(api!, tools, hooks);
				const prompt = session.systemPrompt;
				for (const name of BLOCKING_AGENT_TOOLS) {
					expect(prompt).toContain(`\n- ${name}: ${AGENT_TOOL_SNIPPETS[name]}\n`);
				}
				expect(prompt.split(`reach you at ${address}.`).length).toBe(2);
				expect(prompt).not.toContain("reach you at agents.prompt.pi.me.here.");
				for (const name of BLOCKING_AGENT_TOOLS) {
					for (const guideline of agentToolGuidelines(name, address)) {
						expect(prompt.split(`\n- ${guideline}\n`).length).toBe(2);
					}
				}
			} finally {
				session.dispose();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

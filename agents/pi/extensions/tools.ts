/**
 * The agent tools in PI: the SDK's `AgentTools` offered to PI's model
 * through `pi.registerTool()`.
 *
 * The `agentTools` setting picks the subset (`docs/agent-tools.md` §5):
 * `blocking` (the default: `discover_agents`, `prompt_agent`,
 * `answer_agent`), `all` (the six) or `off` (no tool registered; the
 * channel still keeps its `Agents` client). `NATS_AGENT_TOOLS` wins over
 * the config field, as the channel's other settings do.
 *
 * Each definition becomes one PI tool with the definition's name,
 * description and JSON Schema parameters, the schema object as it is: PI
 * validates a `parameters` object that is not a TypeBox type as JSON
 * Schema and forwards it to the provider unchanged. `execute` runs
 * `tools.execute(name, params, { toolCallId, signal })` inside the
 * extensions' `aroundToolCall` wrapper, with the NATS prompt or the local
 * turn PI is working on, and hands the result back to the model as JSON
 * text.
 *
 * Each tool also carries a `promptSnippet` and `promptGuidelines` for PI's
 * default system prompt. PI lists an extension's tool under `Available
 * tools` only when it has a snippet, and otherwise tells the model only
 * that it "may have access to other custom tools"; the guidelines name the
 * session's own address and how the tools are used. A custom system prompt
 * (`--system-prompt`, `SYSTEM.md`) replaces the default one, and with it
 * both.
 */

import {
  AGENT_TOOL_NAMES,
  BLOCKING_AGENT_TOOLS,
  type AgentToolName,
  type AgentTools,
} from "@synadia-ai/agents";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { LocalTurn, ServedRequest } from "./extensions.ts";

export type AgentToolsMode = "blocking" | "all" | "off";

export const AGENT_TOOLS_MODES: readonly AgentToolsMode[] = [
  "blocking",
  "all",
  "off",
];

export const AGENT_TOOLS_VAR = "NATS_AGENT_TOOLS";

/** `NATS_AGENT_TOOLS`, then the config's `agentTools`, then `blocking`. */
export function resolveAgentToolsMode(
  config: { readonly agentTools?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): AgentToolsMode {
  const value = env[AGENT_TOOLS_VAR] ?? config.agentTools;
  if (value === undefined || value === "") return "blocking";
  if ((AGENT_TOOLS_MODES as readonly unknown[]).includes(value)) {
    return value as AgentToolsMode;
  }
  throw new Error(
    `${AGENT_TOOLS_VAR}/agentTools must be one of ${AGENT_TOOLS_MODES.join(", ")}; got ${JSON.stringify(value)}`,
  );
}

/** The tools a mode offers; `undefined` for `off`. */
export function toolNamesFor(
  mode: AgentToolsMode,
): ReadonlyArray<AgentToolName> | undefined {
  switch (mode) {
    case "blocking":
      return BLOCKING_AGENT_TOOLS;
    case "all":
      return AGENT_TOOL_NAMES;
    case "off":
      return undefined;
  }
}

/** `discover_agents` → `Discover agents`, for PI's tool list. */
export function toolLabel(name: string): string {
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type PiToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

/**
 * One line per tool for the `Available tools` list of PI's default system
 * prompt. Each line costs input tokens on every model call, so it only
 * says what the tool is for; the definition's description says how.
 */
export const AGENT_TOOL_SNIPPETS: Readonly<Record<AgentToolName, string>> = {
  discover_agents:
    "List the agents you can prompt, with each one's address and what it does",
  prompt_agent: "Send a task to another agent and get its reply",
  wait_agent: "Wait for calls started with prompt_agent and collect their results",
  answer_agent: "Answer a question another agent asked while working on your call",
  cancel_agent: "Stop calls started with prompt_agent",
  list_agent_calls: "List the calls started with prompt_agent and their states",
};

/**
 * The bullets a tool adds to the `Guidelines` of PI's default system
 * prompt, naming `address`, the session's own prompt address. PI appends
 * every active tool's bullets flat and drops repeats, so the one that
 * names the address goes on every tool and is shown once, while any of the
 * tools is active.
 */
export function agentToolGuidelines(
  name: AgentToolName,
  address: string,
): string[] {
  const guidelines = [
    `Other agents reach you at ${address}. To reach other agents, use discover_agents and prompt_agent, not shell commands.`,
  ];
  if (name === "discover_agents") {
    guidelines.push(
      "Call discover_agents with no arguments to list every agent. Each of its filters matches one token of an address exactly: no wildcards, never a full address.",
    );
  }
  if (name === "prompt_agent") {
    guidelines.push(
      "Pass prompt_agent the address exactly as discover_agents returned it, and make the prompt self-contained.",
    );
  }
  return guidelines;
}

/** What the registration needs from the channel. */
export interface AgentToolHooks {
  /**
   * The session's own prompt address, as the service registered it (a
   * name already taken gets a `-2`, `-3`, … suffix): named in PI's system
   * prompt.
   */
  readonly address: string;
  /**
   * The NATS prompt PI is serving now, else the local turn it runs, if
   * any: the one the model works in.
   */
  readonly activeRequest: () => ServedRequest | LocalTurn | undefined;
  /** The extensions' wrapper around every tool call. */
  readonly aroundToolCall: <T>(
    request: ServedRequest | LocalTurn | undefined,
    toolName: string,
    run: () => T,
  ) => T;
}

/**
 * Register every definition of `tools` with PI. Returns the names
 * registered, in the helper's order. PI replaces a tool registered again
 * under the same name and rebuilds its system prompt, so a second call
 * with another address replaces the one named.
 */
export function registerAgentTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  tools: Pick<AgentTools, "definitions" | "execute">,
  hooks: AgentToolHooks,
): string[] {
  const names: string[] = [];
  for (const definition of tools.definitions) {
    const name = definition.name;
    pi.registerTool({
      name,
      label: toolLabel(name),
      description: definition.description,
      promptSnippet: AGENT_TOOL_SNIPPETS[name],
      promptGuidelines: agentToolGuidelines(name, hooks.address),
      parameters: definition.parameters as PiToolDefinition["parameters"],
      async execute(toolCallId, params, signal) {
        const result = await hooks.aroundToolCall(
          hooks.activeRequest(),
          name,
          () =>
            tools.execute(name, params, {
              toolCallId,
              ...(signal ? { signal } : {}),
            }),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    });
    names.push(name);
  }
  return names;
}

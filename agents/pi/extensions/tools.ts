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
 * extensions' `aroundToolCall` wrapper, with the request PI is serving,
 * and hands the result back to the model as JSON text.
 */

import {
  AGENT_TOOL_NAMES,
  BLOCKING_AGENT_TOOLS,
  type AgentToolName,
  type AgentTools,
} from "@synadia-ai/agents";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ServedRequest } from "./extensions.ts";

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

/** What the registration needs from the channel. */
export interface AgentToolHooks {
  /** The request PI is serving now, if any: the one the model works in. */
  readonly activeRequest: () => ServedRequest | undefined;
  /** The extensions' wrapper around every tool call. */
  readonly aroundToolCall: <T>(
    request: ServedRequest | undefined,
    toolName: string,
    run: () => T,
  ) => T;
}

/**
 * Register every definition of `tools` with PI. Returns the names
 * registered, in the helper's order.
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

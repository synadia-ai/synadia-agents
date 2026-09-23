/**
 * The agent tools in OpenClaw: the SDK's `AgentTools` offered to OpenClaw's
 * model through the plugin API's `registerTool()` (see `index.ts`).
 *
 * The `agentTools` account setting picks the subset (`docs/agent-tools.md`
 * §5): `blocking` (the default: `discover_agents`, `prompt_agent`,
 * `answer_agent`), `all` (the six) or `off` (no tool offered; the gateway
 * still keeps its `Agents` client). `NATS_AGENT_TOOLS` wins over the
 * account's field, as `NATS_SENDER_IDENTITY` does over `senderIdentity`.
 *
 * Each definition becomes one OpenClaw tool with the definition's name,
 * description and JSON Schema parameters, the schema object as it is:
 * OpenClaw's agent runtime validates a `parameters` object that carries no
 * TypeBox metadata as plain JSON Schema (`validateToolArguments`, in the
 * `pi-ai` it bundles or depends on), and its provider normalisation passes
 * an object schema through unchanged. `execute` runs
 * `tools.execute(name, params, { toolCallId, signal })` inside the
 * extensions' `aroundToolCall` wrapper, with the request OpenClaw is
 * serving, in that request's async context, and hands the result back to
 * the model as JSON text.
 */

import {
  AGENT_TOOL_NAMES,
  BLOCKING_AGENT_TOOLS,
  type AgentToolName,
  type AgentTools,
} from "@synadia-ai/agents";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";

import type { ServedRequest } from "./extensions.js";

export type AgentToolsMode = "blocking" | "all" | "off";

export const AGENT_TOOLS_MODES: readonly AgentToolsMode[] = [
  "blocking",
  "all",
  "off",
];

export const AGENT_TOOLS_VAR = "NATS_AGENT_TOOLS";

/**
 * The mode a setting's value names: unset or empty is `blocking`; anything
 * else must be one of the three. `source` names the setting in the error,
 * the way the account resolver names `senderIdentity`'s.
 */
export function parseAgentToolsMode(value: unknown, source: string): AgentToolsMode {
  if (value === undefined || value === "") return "blocking";
  if ((AGENT_TOOLS_MODES as readonly unknown[]).includes(value)) {
    return value as AgentToolsMode;
  }
  throw new Error(
    `${source} must be one of ${AGENT_TOOLS_MODES.join(", ")}; got ${JSON.stringify(value)}`,
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

/** `discover_agents` → `Discover agents`, for OpenClaw's tool list. */
export function toolLabel(name: string): string {
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The served prompt OpenClaw's model is working in, as the gateway knows
 * it when a tool runs.
 */
export interface ActiveTurn {
  readonly served: ServedRequest;
  /**
   * Run `fn` in the request's async context — the one the prompt handler
   * runs in, which every request interceptor bound and the tools' scope
   * lives in. A no-op when the caller is already there.
   */
  enter<T>(fn: () => T): T;
}

/** What the registration needs from the gateway. */
export interface AgentToolHooks {
  /** The turn OpenClaw is serving now, if any: the one the model works in. */
  readonly activeTurn: () => ActiveTurn | undefined;
  /** The extensions' wrapper around every tool call. */
  readonly aroundToolCall: <T>(
    request: ServedRequest | undefined,
    toolName: string,
    run: () => T,
  ) => T;
}

/** The result shape OpenClaw's agent runtime takes from a tool. */
type OpenClawToolResult = Awaited<ReturnType<AnyAgentTool["execute"]>>;

/**
 * Turn every definition of `tools` into an OpenClaw tool. Returns them in
 * the helper's order, ready for the plugin API's `registerTool()`.
 */
export function registerAgentTools(
  tools: Pick<AgentTools, "definitions" | "execute">,
  hooks: AgentToolHooks,
): AnyAgentTool[] {
  const registered: AnyAgentTool[] = [];
  for (const definition of tools.definitions) {
    const name = definition.name;
    registered.push({
      name,
      label: toolLabel(name),
      description: definition.description,
      // The JSON Schema object as the SDK gives it; OpenClaw takes it as is.
      parameters: definition.parameters as unknown as AnyAgentTool["parameters"],
      async execute(toolCallId, params, signal): Promise<OpenClawToolResult> {
        const turn = hooks.activeTurn();
        const call = (): Promise<unknown> =>
          hooks.aroundToolCall(turn?.served, name, () =>
            tools.execute(name, params, {
              toolCallId,
              ...(signal ? { signal } : {}),
            }),
          );
        const result = await (turn ? turn.enter(call) : call());
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    });
  }
  return registered;
}

/**
 * The agent tools in Claude Code: the SDK's `AgentTools` offered to the
 * model as tools of the channel's MCP server, next to `reply` and
 * `request_info`.
 *
 * The `agentTools` setting picks the subset (`docs/agent-tools.md` §5):
 * `blocking` (the default: `discover_agents`, `prompt_agent`,
 * `answer_agent`), `all` (the six) or `off` (none; the server still keeps
 * its `Agents` client). `NATS_AGENT_TOOLS` wins over `config.json`.
 *
 * An MCP tool call reaches the server as a request of its own, outside the
 * async context of the prompt handler it belongs to. So each definition
 * gets one more optional parameter, `request_id`, the inbound channel
 * request the call is made for — the last active request when omitted —
 * and the call runs re-entered into that request's context: the handler
 * keeps a snapshot of it (`AsyncLocalStorage.snapshot()`), taken after
 * every request interceptor ran, and stays open until `reply` completes the
 * request. Inside it the helper finds the prompt's tools scope and the
 * extensions find what their interceptors bound. The call runs inside the
 * extensions' `aroundToolCall` there, with the model's tool-call id from
 * the PreToolUse hook when one was recorded.
 */

import {
  AGENT_TOOL_NAMES,
  BLOCKING_AGENT_TOOLS,
  type AgentToolName,
  type AgentToolResult,
  type AgentTools,
} from '@synadia-ai/agents'

import type { AgentToolsMode } from './config.js'
import type { ServedRequest } from './extensions.js'

/** The tools a mode offers; `undefined` for `off`. */
export function toolNamesFor(mode: AgentToolsMode): ReadonlyArray<AgentToolName> | undefined {
  switch (mode) {
    case 'blocking':
      return BLOCKING_AGENT_TOOLS
    case 'all':
      return AGENT_TOOL_NAMES
    case 'off':
      return undefined
  }
}

/** The parameter every agent tool gains on the MCP server. */
export const REQUEST_ID_PARAMETER = {
  type: 'string',
  description:
    'The inbound channel request_id this call belongs to; the last active request when omitted.',
} as const

/** An MCP tool as `tools/list` returns it. */
export interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: { readonly type: 'object' } & Readonly<Record<string, unknown>>
}

/**
 * The helper's definitions as MCP tools: the name, the words and the JSON
 * Schema as the SDK gives them, with `request_id` added to the properties
 * (the schemas refuse properties they do not name). The helper ignores
 * arguments it does not define, but the server removes `request_id`
 * before it hands the call on anyway, so the helper sees only its own.
 */
export function mcpAgentTools(tools: Pick<AgentTools, 'definitions'>): McpTool[] {
  return tools.definitions.map((definition) => {
    const parameters = definition.parameters
    const properties =
      typeof parameters.properties === 'object' && parameters.properties !== null
        ? (parameters.properties as Readonly<Record<string, unknown>>)
        : {}
    return {
      name: definition.name,
      description: definition.description,
      inputSchema: {
        ...parameters,
        type: 'object',
        properties: { ...properties, request_id: REQUEST_ID_PARAMETER },
      },
    }
  })
}

/** A served prompt a tool call can run in, as the server tracks it. */
export interface ToolCallRequest {
  readonly served: ServedRequest
  /** Run `fn` in the prompt handler's async context (a snapshot). */
  enter<T>(fn: () => T): T
}

/** Which request a tool call is for. */
export type RequestChoice =
  | { readonly kind: 'request'; readonly request: ToolCallRequest }
  | { readonly kind: 'none' }
  | { readonly kind: 'inactive'; readonly requestId: string }

/**
 * The request a tool call names by `request_id`, else the last active one,
 * else none: the call then runs outside any served prompt, as the local
 * user's own. A `request_id` that names no active request is refused
 * rather than guessed at, as `reply` refuses it.
 */
export function chooseRequest(
  args: Readonly<Record<string, unknown>>,
  active: (requestId: string) => ToolCallRequest | undefined,
  lastActiveRequestId: string | undefined,
): RequestChoice {
  const named = args.request_id
  if (typeof named === 'string' && named.length > 0) {
    const request = active(named)
    return request ? { kind: 'request', request } : { kind: 'inactive', requestId: named }
  }
  const fallback = lastActiveRequestId !== undefined ? active(lastActiveRequestId) : undefined
  return fallback ? { kind: 'request', request: fallback } : { kind: 'none' }
}

/** Everything one agent-tool call needs from the server. */
export interface AgentToolCall {
  readonly tools: Pick<AgentTools, 'execute'>
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly request: ToolCallRequest | undefined
  /** The model's tool-call id from the PreToolUse hook, when recorded. */
  readonly toolCallId: string | undefined
  readonly signal: AbortSignal | undefined
  readonly aroundToolCall: <T>(
    request: ServedRequest | undefined,
    toolName: string,
    run: () => T,
  ) => T
}

/**
 * Run one agent-tool call: `request_id` removed, re-entered into the
 * request's context when there is one, inside the extensions'
 * `aroundToolCall`, `tools.execute(name, args, { toolCallId, signal })`.
 */
export function runAgentTool(call: AgentToolCall): Promise<AgentToolResult> {
  const { request_id: _requestId, ...args } = call.args
  const run = (): Promise<AgentToolResult> =>
    call.aroundToolCall(call.request?.served, call.name, () =>
      call.tools.execute(call.name, args, {
        ...(call.toolCallId !== undefined ? { toolCallId: call.toolCallId } : {}),
        ...(call.signal ? { signal: call.signal } : {}),
      }),
    )
  return call.request ? call.request.enter(run) : run()
}

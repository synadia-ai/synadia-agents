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
 * request the call is made for. When it is omitted, the turn that made the
 * call decides ({@link chooseRequest}): the call's prompt id, from the
 * PreToolUse hook, names its turn (`src/turns.ts`). A turn runs its calls
 * in the last channel request taken into it that is still open: the one
 * that started it, or one folded into it, a typed turn's too, so the
 * agents prompted after a fold hang under the request whose window the
 * turn's model calls are filed in from the fold. With none open, a local
 * turn (typed at the terminal, or begun by Claude Code itself) runs them in
 * the local turn. The
 * call runs re-entered into the request's context: the handler keeps a
 * snapshot of it (`AsyncLocalStorage.snapshot()`), taken after every
 * request interceptor ran, and stays open until `reply` completes the
 * request. Inside it the helper finds the prompt's tools scope and the
 * extensions find what their interceptors bound. A local turn's call runs
 * in the helper's own scope, as the local user's. Either way the call runs
 * inside the extensions' `aroundToolCall`, which is told the request or the
 * local turn, with the model's tool-call id from the PreToolUse hook when
 * one was recorded.
 */

import {
  AGENT_TOOL_NAMES,
  BLOCKING_AGENT_TOOLS,
  type AgentToolName,
  type AgentToolResult,
  type AgentTools,
} from '@synadia-ai/agents'

import type { AgentToolsMode } from './config.js'
import type { LocalTurn, ServedRequest } from './extensions.js'
import type { Turn } from './turns.js'

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
    'The inbound channel request_id this call belongs to. When omitted, the turn making the call decides: the channel request that turn serves, or none for a turn typed in this session.',
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

/** Which request, or which local turn, a tool call is for. */
export type RequestChoice =
  | { readonly kind: 'request'; readonly request: ToolCallRequest }
  | { readonly kind: 'local'; readonly turn: LocalTurn }
  | { readonly kind: 'none' }
  | { readonly kind: 'inactive'; readonly requestId: string }

/** The turns as the server follows them (`TurnTracker`), as far as a call needs them. */
export interface TurnLookup {
  /** The turn a prompt id names: the current one, or one that ended lately. */
  turn(promptId: string): Turn | undefined
  /** The turn running now. */
  current(): Turn | undefined
}

/** What the server knows of the call itself. */
export interface ToolCallTurn {
  /** The call's prompt id, from its PreToolUse record. */
  readonly promptId?: string
  readonly turns?: TurnLookup
}

/**
 * The request a tool call is for, in this order:
 *
 *   1. the one `request_id` names; one that names no active request is
 *      refused rather than guessed at, as `reply` refuses it;
 *   2. else the turn the call's own prompt id names: the last request taken
 *      into it that is still open (the one that started it, or one folded
 *      into it, a local turn's too); with none open, a local turn runs the
 *      call in itself;
 *   3. else (no PreToolUse record: dropped after a minute, a permission
 *      dialog left waiting, or a hook that timed out) the turn running now,
 *      the same way;
 *   4. else, when the turns are not followed (a Claude Code that reports no
 *      submits), the last active request.
 *
 * A served turn whose requests have all finished gives none: the call runs
 * outside any served prompt, as the local user's own, never in a request
 * that waits for a later turn. So does step 4 with no active request. A
 * local turn whose folded request has finished runs its calls in itself
 * again.
 */
export function chooseRequest(
  args: Readonly<Record<string, unknown>>,
  active: (requestId: string) => ToolCallRequest | undefined,
  lastActiveRequestId: string | undefined,
  call: ToolCallTurn = {},
): RequestChoice {
  const named = args.request_id
  if (typeof named === 'string' && named.length > 0) {
    const request = active(named)
    return request ? { kind: 'request', request } : { kind: 'inactive', requestId: named }
  }
  const turn =
    (call.promptId !== undefined ? call.turns?.turn(call.promptId) : undefined) ?? call.turns?.current()
  if (turn !== undefined) {
    const open = turn.requests.map((id) => active(id)).filter((r) => r !== undefined)
    const last = open.at(-1)
    if (last !== undefined) return { kind: 'request', request: last }
    return turn.local !== undefined ? { kind: 'local', turn: turn.local } : { kind: 'none' }
  }
  const fallback = lastActiveRequestId !== undefined ? active(lastActiveRequestId) : undefined
  return fallback ? { kind: 'request', request: fallback } : { kind: 'none' }
}

function isLocalTurn(work: ToolCallRequest | LocalTurn): work is LocalTurn {
  return 'local' in work && work.local === true
}

/** Everything one agent-tool call needs from the server. */
export interface AgentToolCall {
  readonly tools: Pick<AgentTools, 'execute'>
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  /** The request the call is for, or the local turn, or neither. */
  readonly request: ToolCallRequest | LocalTurn | undefined
  /** The model's tool-call id from the PreToolUse hook, when recorded. */
  readonly toolCallId: string | undefined
  readonly signal: AbortSignal | undefined
  readonly aroundToolCall: <T>(
    request: ServedRequest | LocalTurn | undefined,
    toolName: string,
    run: () => T,
  ) => T
}

/**
 * Run one agent-tool call: `request_id` removed, re-entered into the
 * request's context when there is one, inside the extensions'
 * `aroundToolCall`, `tools.execute(name, args, { toolCallId, signal })`. A
 * local turn has no handler and no snapshot: its call runs where it is,
 * and the extensions are told the turn.
 */
export function runAgentTool(call: AgentToolCall): Promise<AgentToolResult> {
  const { request_id: _requestId, ...args } = call.args
  const work = call.request
  const local = work !== undefined && isLocalTurn(work) ? work : undefined
  const request = work !== undefined && !isLocalTurn(work) ? work : undefined
  const run = (): Promise<AgentToolResult> =>
    call.aroundToolCall(local ?? request?.served, call.name, () =>
      call.tools.execute(call.name, args, {
        ...(call.toolCallId !== undefined ? { toolCallId: call.toolCallId } : {}),
        ...(call.signal ? { signal: call.signal } : {}),
      }),
    )
  return request ? request.enter(run) : run()
}

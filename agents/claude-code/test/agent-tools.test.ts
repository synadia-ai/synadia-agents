// The agent tools on the MCP server: the subset each mode offers, the
// helper's definitions as MCP tools with `request_id`, which request a call
// is for, and the call itself — `request_id` removed, the PreToolUse id and
// the signal passed, inside `aroundToolCall`, re-entered into the request's
// context. The helper is built over a client that never connects; no NATS
// is needed.

import { describe, expect, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { NatsConnection } from '@nats-io/transport-node'
import {
  AGENT_TOOL_NAMES,
  Agents,
  AgentTools,
  BLOCKING_AGENT_TOOLS,
  type AgentToolCallOptions,
  type AgentToolResult,
} from '@synadia-ai/agents'
import {
  REQUEST_ID_PARAMETER,
  chooseRequest,
  mcpAgentTools,
  runAgentTool,
  toolNamesFor,
  type ToolCallRequest,
} from '../src/agent-tools.js'
import type { ServedRequest } from '../src/extensions.js'

// The helper only stores the client until a tool call needs the bus.
const offlineAgents = new Agents({ nc: {} as unknown as NatsConnection })

const passthrough = <T>(_r: ServedRequest | undefined, _n: string, run: () => T): T => run()

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('the modes and the MCP definitions', () => {
  test('blocking is the SDK\'s three, all is the six, off is none', () => {
    expect(toolNamesFor('blocking')).toEqual(BLOCKING_AGENT_TOOLS)
    expect(toolNamesFor('all')).toEqual(AGENT_TOOL_NAMES)
    expect(toolNamesFor('off')).toBeUndefined()
  })

  test('each definition keeps the helper\'s name, words and schema, with request_id added as optional', () => {
    const tools = new AgentTools({ agents: offlineAgents, tools: BLOCKING_AGENT_TOOLS })
    const listed = mcpAgentTools(tools)
    expect(listed.map((t) => t.name)).toEqual([...BLOCKING_AGENT_TOOLS])
    for (const [i, definition] of tools.definitions.entries()) {
      const mcp = listed[i]!
      expect(mcp.description).toBe(definition.description)
      const { properties, ...rest } = mcp.inputSchema as { properties: Record<string, unknown> }
      const { properties: original, ...originalRest } = definition.parameters as {
        properties: Record<string, unknown>
      }
      expect(rest).toEqual(originalRest)
      expect(properties).toEqual({ ...original, request_id: REQUEST_ID_PARAMETER })
      expect((mcp.inputSchema.required as string[] | undefined) ?? []).not.toContain('request_id')
    }
    // The helper's own copy is untouched.
    expect(Object.keys(tools.definitions[0]!.parameters.properties as object)).not.toContain(
      'request_id',
    )
  })

  test('all lists the six', () => {
    const tools = new AgentTools({ agents: offlineAgents, tools: AGENT_TOOL_NAMES })
    expect(mcpAgentTools(tools).map((t) => t.name)).toEqual([...AGENT_TOOL_NAMES])
  })
})

describe('chooseRequest: request_id, else the last active request', () => {
  const r1: ToolCallRequest = { served: { id: '1', extras: {} }, enter: (fn) => fn() }
  const r2: ToolCallRequest = { served: { id: '2', extras: {} }, enter: (fn) => fn() }
  const active = (id: string): ToolCallRequest | undefined =>
    ({ '1': r1, '2': r2 })[id as '1' | '2']

  test('request_id names the request', () => {
    expect(chooseRequest({ request_id: '1' }, active, '2')).toEqual({ kind: 'request', request: r1 })
  })

  test('without request_id, the last active request', () => {
    expect(chooseRequest({}, active, '2')).toEqual({ kind: 'request', request: r2 })
    expect(chooseRequest({ request_id: '' }, active, '2')).toEqual({ kind: 'request', request: r2 })
  })

  test('with no active request, none: the call is the local user\'s', () => {
    expect(chooseRequest({}, active, undefined)).toEqual({ kind: 'none' })
    expect(chooseRequest({}, active, '9')).toEqual({ kind: 'none' })
  })

  test('a request_id naming no active request is refused, not guessed at', () => {
    expect(chooseRequest({ request_id: '9' }, active, '2')).toEqual({
      kind: 'inactive',
      requestId: '9',
    })
  })
})

describe('runAgentTool', () => {
  test('passes the arguments without request_id, the PreToolUse id and the signal, inside aroundToolCall, in the request\'s context', async () => {
    const als = new AsyncLocalStorage<string>()
    const calls: Array<{ name: string; args: unknown; options: AgentToolCallOptions; store?: string }> = []
    const fakeTools = {
      async execute(name: string, args?: unknown, options: AgentToolCallOptions = {}): Promise<AgentToolResult> {
        calls.push({ name, args, options, store: als.getStore() })
        return { reply: 'ok' }
      },
    }
    const served: ServedRequest = { id: '42', extras: {} }
    const request: ToolCallRequest = {
      served,
      enter: als.run.bind(als, 'request:42') as ToolCallRequest['enter'],
    }
    const wrapped: Array<[string | undefined, string, string | undefined]> = []
    const controller = new AbortController()
    const result = await runAgentTool({
      tools: fakeTools,
      name: 'prompt_agent',
      args: { request_id: '42', address: 'a', prompt: 'p' },
      request,
      toolCallId: 'toolu_9',
      signal: controller.signal,
      aroundToolCall: (r, name, run) => {
        wrapped.push([r?.id, name, als.getStore()])
        return run()
      },
    })
    expect(result).toEqual({ reply: 'ok' })
    expect(calls).toEqual([{
      name: 'prompt_agent',
      args: { address: 'a', prompt: 'p' },
      options: { toolCallId: 'toolu_9', signal: controller.signal },
      store: 'request:42',
    }])
    // The wrapper runs in the request's context too.
    expect(wrapped).toEqual([['42', 'prompt_agent', 'request:42']])
  })

  test('without a request or a recorded id: the wrapper gets undefined and no toolCallId is passed', async () => {
    const seen: Array<[string | undefined, AgentToolCallOptions]> = []
    await runAgentTool({
      tools: {
        async execute(_n: string, _a?: unknown, options: AgentToolCallOptions = {}) {
          seen.push([undefined, options])
          return {}
        },
      },
      name: 'discover_agents',
      args: {},
      request: undefined,
      toolCallId: undefined,
      signal: undefined,
      aroundToolCall: (r, _n, run) => {
        seen.push([r?.id, {}])
        return run()
      },
    })
    expect(seen).toEqual([[undefined, {}], [undefined, {}]])
  })
})

describe('the snapshot re-entry: a tool call arriving outside the handler gets the handler\'s context', () => {
  // As the service runs them: the extension's request interceptor first,
  // then the tools' scope, then the handler, which takes the snapshot and
  // stays open until the request completes (the reply tool with done).
  async function serveOnePrompt(tools: AgentTools, als: AsyncLocalStorage<string>) {
    const completion = deferred()
    let enter!: <T>(fn: () => T) => T
    const snapshotTaken = deferred()
    const handlerDone = als.run('bound-by-extension', () =>
      tools.requestInterceptor.aroundRequest({}, async () => {
        enter = AsyncLocalStorage.snapshot()
        snapshotTaken.resolve()
        await completion.promise
      }),
    )
    await snapshotTaken.promise
    return { enter: <T>(fn: () => T): T => enter(fn), complete: completion.resolve, handlerDone }
  }

  test('the call runs in the prompt\'s tools scope and sees the extension\'s binding; after done, the scope has ended', async () => {
    const als = new AsyncLocalStorage<string>()
    const tools = new AgentTools({ agents: offlineAgents, tools: BLOCKING_AGENT_TOOLS })
    const served: ServedRequest = { id: '1', extras: {} }
    const prompt = await serveOnePrompt(tools, als)
    const request: ToolCallRequest = { served, enter: prompt.enter }
    const args = { request_id: '1', address: 'agents.prompt.x.acme.other', prompt: 'hi' }
    const seen: Array<string | undefined> = []
    const call = (r: ToolCallRequest | undefined) =>
      runAgentTool({
        tools,
        name: 'prompt_agent',
        args,
        request: r,
        toolCallId: undefined,
        signal: undefined,
        aroundToolCall: (_r, _n, run) => {
          seen.push(als.getStore())
          return run()
        },
      })

    // Outside the handler's context: the extension's binding is not there.
    expect(als.getStore()).toBeUndefined()
    // In the open prompt's scope the call proceeds to the lookup, which
    // fails on the offline client.
    const open = await call(request)
    expect(String(open.error)).toMatch(/could not look up/)

    prompt.complete()
    await prompt.handlerDone
    // Re-entered after the handler returned: the prompt's scope is closed.
    const afterDone = await call(request)
    expect(afterDone.error).toBe('the prompt you were answering has ended; no call can start in it')
    // Without the snapshot the call is the local user's, in the helper's own scope.
    const outside = await call(undefined)
    expect(String(outside.error)).toMatch(/could not look up/)

    expect(seen).toEqual(['bound-by-extension', 'bound-by-extension', undefined])
    await tools.close()
  })
})

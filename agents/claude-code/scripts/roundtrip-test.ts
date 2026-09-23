#!/usr/bin/env bun
/**
 * Artifact-only end-to-end test. A minimal marketplace-style cache copy gets
 * only the descriptor and committed bundle, then a fake Claude MCP client and
 * a NATS caller exercise the complete channel lifecycle.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { connect } from '@nats-io/transport-node'
import { Agents } from '@synadia-ai/agents'
import { AgentService } from '@synadia-ai/agent-service'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWNER = 'roundtrip'
const NAME = 'rt-test'
const SUBJECT = `agents.prompt.cc.${OWNER}.${NAME}`
const NATS_URL = process.env.NATS_URL ?? 'nats://127.0.0.1:4222'
const MAX_PAYLOAD = 1024 * 1024
const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cacheRoot = mkdtempSync(join(tmpdir(), 'claude-plugin-cache-'))
const stateDir = mkdtempSync(join(tmpdir(), 'claude-channel-state-'))

mkdirSync(join(cacheRoot, '.claude-plugin'), { recursive: true })
mkdirSync(join(cacheRoot, 'runtime'), { recursive: true })
copyFileSync(
  join(sourceRoot, '.claude-plugin', 'plugin.json'),
  join(cacheRoot, '.claude-plugin', 'plugin.json'),
)
copyFileSync(join(sourceRoot, 'runtime', 'server.js'), join(cacheRoot, 'runtime', 'server.js'))
Bun.write(
  join(stateDir, 'config.json'),
  JSON.stringify({ permissions: { mode: 'query' } }),
)

// An extension named by the variable, from an absolute path: it logs what
// the channel hands it, one JSON line per event, into the state directory.
const extensionPath = join(stateDir, 'rt-extension.mjs')
const extensionLog = join(stateDir, 'rt-extension.log')
writeFileSync(extensionPath, `
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
export default function (ctx) {
  const log = (e) => appendFileSync(join(ctx.settings.stateDir, 'rt-extension.log'), JSON.stringify(e) + '\\n')
  const als = new AsyncLocalStorage()
  log({ event: 'factory', harness: ctx.harness, plugin: ctx.plugin.name, name: ctx.settings.name })
  return {
    name: 'rt-ext',
    requestInterceptors: [{ aroundRequest: (_c, next) => als.run('served', next) }],
    promptInterceptors: [{
      beforePrompt: (c) => { log({ event: 'beforePrompt', toolCallId: c.context.toolCallId ?? null, bound: als.getStore() ?? null }) },
    }],
    started: () => log({ event: 'started' }),
    events: {
      promptAccepted: (r) => log({ event: 'promptAccepted', id: r.id, sessionId: r.sessionId ?? null, extras: r.extras, bound: als.getStore() ?? null }),
      promptEnded: (r, outcome) => log({ event: 'promptEnded', id: r.id, outcome }),
      aroundToolCall: (r, tool, run) => { log({ event: 'aroundToolCall', id: r?.id ?? null, tool, bound: als.getStore() ?? null }); return run() },
      sessionStarted: (id, source) => log({ event: 'sessionStarted', id, source }),
      turnStopped: (id) => log({ event: 'turnStopped', id: id ?? null }),
    },
  }
}
`)
type ExtensionEvent = Record<string, unknown> & { event: string }
function extensionEvents(): ExtensionEvent[] {
  if (!existsSync(extensionLog)) return []
  return readFileSync(extensionLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as ExtensionEvent)
}

// The plugin's hook, run from source as Claude Code runs it; this process
// stands in for Claude Code, so its pid keys the files and the sweep keeps them.
const SESSION_ID = '5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
async function runHook(input: Record<string, unknown>): Promise<void> {
  const child = Bun.spawn([process.execPath, join(sourceRoot, 'hooks', 'session-event.ts')], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: { ...process.env, CLAUDE_PID: String(process.pid), NATS_STATE_DIR: stateDir },
  })
  if ((await child.exited) !== 0) throw new Error('hook exited non-zero')
}
await runHook({ hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'startup' })

const nc = await connect({ servers: NATS_URL, name: 'claude-channel-roundtrip-probe' })
const discovery = new Agents({ nc })
const childEnv: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && key !== 'NATS_CONTEXT') childEnv[key] = value
}
Object.assign(childEnv, {
  CLAUDE_CWD: '/tmp/rt-test',
  NATS_URL,
  NATS_SESSION_NAME: NAME,
  NATS_STATE_DIR: stateDir,
  NATS_SENDER_IDENTITY: 'off',
  NATS_MIN_SENDER_TRUST: 'any',
  SYNADIA_CLAUDE_CODE_OWNER: OWNER,
  SYNADIA_CLAUDE_CODE_EXTENSIONS: extensionPath,
  CLAUDE_PID: String(process.pid),
})

const transport = new StdioClientTransport({
  command: 'bun',
  args: [join(cacheRoot, 'runtime', 'server.js')],
  env: childEnv,
})
const mcp = new Client({ name: 'fake-claude', version: '0.0.1' })

type PromptCase = {
  replyHandler: (requestId: string, meta: Record<string, unknown>, content: string) => Promise<void>
}

let currentCase: PromptCase | undefined
let permissionResult: ((behavior: string) => void) | undefined
mcp.fallbackNotificationHandler = async notification => {
  if (notification.method === 'notifications/claude/channel') {
    if (!currentCase) return
    const params = notification.params as {
      meta: Record<string, unknown>
      content: string
    }
    await currentCase.replyHandler(String(params.meta.request_id), params.meta, params.content)
  }
  if (notification.method === 'notifications/claude/channel/permission') {
    const params = notification.params as { behavior?: string }
    permissionResult?.(params.behavior ?? '')
  }
}

await mcp.connect(transport)

let discovered: Awaited<ReturnType<Agents['discover']>>[number] | undefined
for (let attempt = 0; attempt < 20 && !discovered; attempt++) {
  const found = await discovery.discover({
    timeoutMs: 100,
    filter: { agent: 'claude-code', owner: OWNER, name: NAME },
  })
  discovered = found[0]
}
if (!discovered) throw new Error('bundled plugin did not register from the cache copy')
if (discovered.identity !== undefined) throw new Error('identity-off plugin registered an identity')
if (discovered.minSenderTrust !== 'any') throw new Error('default min_sender_trust is not any')

type Collected = { body: string; bytes: number; hasHeaders: boolean }
async function collectChunks(
  requestBody: string | Uint8Array,
  onChunk?: (chunk: Collected) => Promise<void> | void,
): Promise<Collected[]> {
  const inbox = `_INBOX.rt.${Math.random().toString(36).slice(2, 10)}`
  const sub = nc.subscribe(inbox)
  const chunks: Collected[] = []
  const collect = (async () => {
    for await (const message of sub) {
      const bytes = message.data.byteLength
      const chunk = {
        body: bytes === 0 ? '' : new TextDecoder().decode(message.data),
        bytes,
        hasHeaders: !!message.headers,
      }
      chunks.push(chunk)
      await onChunk?.(chunk)
      if (bytes === 0 && !message.headers) break
    }
  })()
  nc.publish(SUBJECT, requestBody, { reply: inbox })
  await nc.flush()
  const timer = setTimeout(() => sub.unsubscribe(), 15_000)
  await collect.catch(() => undefined)
  clearTimeout(timer)
  return chunks
}

let failures = 0
function fail(message: string): void {
  console.error(`  FAIL: ${message}`)
  failures++
}

function parsed(chunk: Collected): Record<string, unknown> {
  return JSON.parse(chunk.body) as Record<string, unknown>
}

function assertAck(chunk: Collected | undefined): void {
  if (!chunk) return fail('missing leading ack')
  const value = parsed(chunk)
  if (value.type !== 'status' || value.data !== 'ack') fail('first message is not the leading ack')
}

console.log('\n[case 1] cached bundle, safe sender exposure, streaming, terminator')
{
  currentCase = {
    replyHandler: async (requestId, meta, content) => {
      if (content !== 'hello from the probe') fail('model-visible prompt changed')
      if ('sender' in meta || 'identity' in meta || 'trust' in meta) {
        fail('sender identity leaked into model-visible channel metadata')
      }
      const info = await mcp.callTool({ name: 'request_info', arguments: { request_id: requestId } })
      const infoText = info.content[0]?.type === 'text' ? info.content[0].text : ''
      if (!infoText.includes('(no sender)')) fail('request_info did not expose the classified sender')
      if (!infoText.includes('"extensions":["rt-ext"]')) fail('request_info did not list the loaded extension')
      await mcp.callTool({
        name: 'reply',
        arguments: { request_id: requestId, text: 'part one ', done: false },
      })
      await mcp.callTool({
        name: 'reply',
        arguments: { request_id: requestId, text: 'part two', done: true },
      })
    },
  }
  const chunks = await collectChunks('hello from the probe')
  if (chunks.length !== 4) fail(`expected ack + 2 responses + terminator, got ${chunks.length}`)
  assertAck(chunks[0])
  const first = parsed(chunks[1]!)
  const second = parsed(chunks[2]!)
  if (first.type !== 'response' || first.data !== 'part one ') fail('first response shape')
  if (second.type !== 'response' || second.data !== 'part two') fail('second response shape')
  const term = chunks.at(-1)!
  if (term.bytes !== 0 || term.hasHeaders) fail('terminator must be empty and headerless')
}

console.log('\n[case 2] attachment staging and completion cleanup')
{
  const fileBytes = new TextEncoder().encode('hello-attachment-contents\n')
  const envelope = JSON.stringify({
    prompt: 'what is in this file?',
    attachments: [{ filename: 'note.txt', content: Buffer.from(fileBytes).toString('base64') }],
  })
  let stagedPath: string | undefined
  let preReplyContents: string | undefined
  currentCase = {
    replyHandler: async (requestId, _meta, content) => {
      const match = /^- (\S.+)$/m.exec(content)
      stagedPath = match?.[1]
      if (stagedPath) preReplyContents = readFileSync(stagedPath, 'utf8')
      await mcp.callTool({ name: 'reply', arguments: { request_id: requestId, text: 'ok' } })
    },
  }
  const chunks = await collectChunks(envelope)
  if (chunks.length !== 3) fail(`expected ack + response + terminator, got ${chunks.length}`)
  assertAck(chunks[0])
  if (preReplyContents !== 'hello-attachment-contents\n') fail('staged attachment contents differ')
  await Bun.sleep(50)
  if (stagedPath && existsSync(stagedPath)) fail('staged attachment was not cleaned up')
}

console.log('\n[case 3] oversized response splitting')
{
  const large = 'x'.repeat(1_400_000)
  currentCase = {
    replyHandler: async requestId => {
      await mcp.callTool({ name: 'reply', arguments: { request_id: requestId, text: large } })
    },
  }
  const chunks = await collectChunks('give me the payload')
  assertAck(chunks[0])
  let reconstructed = ''
  for (const chunk of chunks.slice(1, -1)) {
    if (chunk.bytes > MAX_PAYLOAD) fail(`response exceeds max_payload (${chunk.bytes})`)
    const value = parsed(chunk)
    if (value.type !== 'response') fail('non-response chunk in split response')
    reconstructed += typeof value.data === 'string'
      ? value.data
      : String((value.data as { text?: unknown }).text ?? '')
  }
  if (reconstructed !== large) fail('split response did not reconstruct exactly')
}

console.log('\n[case 4] permission notification uses a protocol query roundtrip')
{
  let permissionBehavior = ''
  currentCase = {
    replyHandler: async requestId => {
      const result = new Promise<string>(resolve => { permissionResult = resolve })
      await mcp.notification({
        method: 'notifications/claude/channel/permission_request',
        params: {
          request_id: 'permission-1',
          tool_name: 'Bash',
          description: 'run a command',
          input_preview: 'pwd',
        },
      })
      permissionBehavior = await result
      permissionResult = undefined
      await mcp.callTool({ name: 'reply', arguments: { request_id: requestId, text: 'allowed' } })
    },
  }
  const chunks = await collectChunks('please inspect the directory', chunk => {
    if (chunk.bytes === 0 || chunk.hasHeaders) return
    const value = parsed(chunk)
    if (value.type !== 'query') return
    const data = value.data as { reply_subject?: string }
    if (data.reply_subject) nc.publish(data.reply_subject, 'yes')
  })
  assertAck(chunks[0])
  if (permissionBehavior !== 'allow') fail(`permission result was ${permissionBehavior || 'missing'}`)
  if (!chunks.some(chunk => chunk.body.includes('"type":"query"'))) fail('no query chunk received')
}

console.log('\n[case 5] agent tools, the PreToolUse id, the snapshot re-entry and the extension events')
{
  // Another agent on the bus for the channel's model to prompt.
  const target = new AgentService({
    nc,
    agent: 'rt-target',
    owner: OWNER,
    name: 'target',
    session: 'target',
    description: 'echo',
    version: '0.0.1',
  })
  target.onPrompt(async (envelope, response) => {
    await response.send(`echo: ${envelope.prompt}`)
  })
  await target.start()
  const targetAddress = target.subject.prompt

  const listed = await mcp.listTools()
  const names = listed.tools.map(tool => tool.name)
  for (const name of ['reply', 'request_info', 'discover_agents', 'prompt_agent', 'answer_agent']) {
    if (!names.includes(name)) fail(`tools/list lacks ${name}`)
  }
  if (names.includes('wait_agent')) fail('the default blocking mode listed wait_agent')
  const promptTool = listed.tools.find(tool => tool.name === 'prompt_agent')
  const promptProperties = (promptTool?.inputSchema.properties ?? {}) as Record<string, unknown>
  if (!('request_id' in promptProperties)) fail('prompt_agent lacks the request_id parameter')

  let toolReply: unknown
  let servedRequestId = ''
  currentCase = {
    replyHandler: async requestId => {
      servedRequestId = requestId
      const args = { request_id: requestId, address: targetAddress, prompt: 'ping' }
      // Claude Code runs the PreToolUse hook to completion, then sends the call.
      await runHook({
        hook_event_name: 'PreToolUse',
        session_id: SESSION_ID,
        tool_use_id: 'toolu_roundtrip_1',
        tool_name: 'mcp__plugin_nats-channel_nats__prompt_agent',
        tool_input: args,
      })
      const result = await mcp.callTool({ name: 'prompt_agent', arguments: args })
      toolReply = result.content[0]?.type === 'text' ? JSON.parse(result.content[0].text) : undefined
      await mcp.callTool({ name: 'reply', arguments: { request_id: requestId, text: 'asked' } })
      await runHook({ hook_event_name: 'Stop', session_id: SESSION_ID })
    },
  }
  const chunks = await collectChunks(JSON.stringify({ prompt: 'ask the other agent', trace_hint: 'x' }))
  assertAck(chunks[0])
  if ((toolReply as { reply?: unknown } | undefined)?.reply !== 'echo: ping') {
    fail(`prompt_agent result was ${JSON.stringify(toolReply)}`)
  }
  // A request_id that names no active request is refused.
  const stale = await mcp.callTool({
    name: 'discover_agents',
    arguments: { request_id: servedRequestId },
  })
  if (!stale.isError) fail('a tool call naming a completed request was not refused')

  let events = extensionEvents()
  for (let i = 0; i < 40 && !events.some(e => e.event === 'turnStopped'); i++) {
    await Bun.sleep(50)
    events = extensionEvents()
  }
  const find = (event: string) => events.find(e => e.event === event)
  const factory = find('factory')
  if (factory?.harness !== 'claude-code' || factory.plugin !== 'claude-channel-nats' || factory.name !== NAME) {
    fail(`factory context was ${JSON.stringify(factory)}`)
  }
  if (!find('started')) fail('started() was not called')
  const session = find('sessionStarted')
  if (session?.id !== SESSION_ID || session.source !== 'startup') fail(`sessionStarted was ${JSON.stringify(session)}`)
  const accepted = events.find(e => e.event === 'promptAccepted' && e.id === servedRequestId)
  if (accepted?.sessionId !== SESSION_ID) fail('promptAccepted lacks the session id')
  if ((accepted?.extras as Record<string, unknown> | undefined)?.trace_hint !== 'x') fail('promptAccepted lacks the extras')
  if (accepted?.bound !== 'served') fail('promptAccepted did not run in the interceptor\'s context')
  const around = find('aroundToolCall')
  if (around?.id !== servedRequestId || around.tool !== 'prompt_agent') fail(`aroundToolCall was ${JSON.stringify(around)}`)
  if (around?.bound !== 'served') fail('the tool call was not re-entered into the handler\'s context')
  const before = find('beforePrompt')
  if (before?.toolCallId !== 'toolu_roundtrip_1') fail(`the PreToolUse id did not reach execute: ${JSON.stringify(before)}`)
  if (before?.bound !== 'served') fail('the prompt interceptor did not run in the handler\'s context')
  const ended = events.find(e => e.event === 'promptEnded' && e.id === servedRequestId)
  if (ended?.outcome !== 'ok') fail(`promptEnded was ${JSON.stringify(ended)}`)
  const stopped = find('turnStopped')
  if (stopped?.id !== SESSION_ID) fail(`turnStopped was ${JSON.stringify(stopped)}`)
  await target.stop()
}

console.log('\n[case 6] shutdown settles an open deferred request')
{
  currentCase = { replyHandler: async () => undefined }
  let acknowledge!: () => void
  const acknowledged = new Promise<void>(resolve => { acknowledge = resolve })
  const collecting = collectChunks('leave this request open', chunk => {
    if (chunk.body.includes('"type":"status"')) acknowledge()
  })
  await acknowledged
  await mcp.close()
  const chunks = await collecting
  assertAck(chunks[0])
  if (!chunks.some(chunk => chunk.hasHeaders)) fail('shutdown did not emit an error frame')
  const term = chunks.at(-1)!
  if (term.bytes !== 0 || term.hasHeaders) fail('shutdown stream lacks a clean terminator')
}

await discovery.close()
await nc.drain()
rmSync(stateDir, { recursive: true, force: true })
rmSync(cacheRoot, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nALL PASS')

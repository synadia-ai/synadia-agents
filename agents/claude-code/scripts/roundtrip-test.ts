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
// Short, so a prompt that owned no turn is ended within the run.
const TURN_START_GRACE_MS = 3000
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
    // One key of its own and one the protocol sets: only the first is registered.
    metadata: { rt_feature: 'on', session: 'not-this-one' },
    started: () => log({ event: 'started' }),
    events: {
      promptAccepted: (r) => log({ event: 'promptAccepted', id: r.id, sessionId: r.sessionId ?? null, extras: r.extras, bound: als.getStore() ?? null }),
      promptEnded: (r, outcome, _at, reason) => log({ event: 'promptEnded', id: r.id, outcome, reason: reason ?? null }),
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
// Returns what the hook printed: nothing, or a refused stop's decision.
async function runHook(input: Record<string, unknown>): Promise<string> {
  const child = Bun.spawn([process.execPath, join(sourceRoot, 'hooks', 'session-event.ts')], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    env: { ...process.env, CLAUDE_PID: String(process.pid), NATS_STATE_DIR: stateDir },
  })
  const stdout = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error('hook exited non-zero')
  return stdout
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
  SYNADIA_CLAUDE_CODE_TURN_START_GRACE_MS: String(TURN_START_GRACE_MS),
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
const permissionResults = new Map<string, (behavior: string) => void>()
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
    const params = notification.params as { request_id?: string; behavior?: string }
    permissionResults.get(String(params.request_id))?.(params.behavior ?? '')
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
if (discovered.metadata.rt_feature !== 'on') throw new Error('the extension\'s metadata key was not registered')
if (discovered.metadata.session !== NAME) throw new Error('the extension overrode a registration key')

// An extension with an invalid metadata key: the server exits at start,
// before it connects, and names the key.
{
  const badPath = join(stateDir, 'rt-bad-metadata.mjs')
  writeFileSync(badPath, `export default () => ({ name: 'rt-bad', metadata: { 'not a key': 'v' } })\n`)
  const child = Bun.spawn(['bun', join(cacheRoot, 'runtime', 'server.js')], {
    env: { ...childEnv, SYNADIA_CLAUDE_CODE_EXTENSIONS: badPath, NATS_SESSION_NAME: 'rt-bad' },
    stdin: 'pipe',
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => 'timeout' as const)])
  if (exited === 'timeout') {
    child.kill()
    throw new Error('the server with an invalid metadata key did not exit')
  }
  const stderr = await new Response(child.stderr).text()
  if (exited === 0) throw new Error('the server with an invalid metadata key exited 0')
  if (!stderr.includes('extension "rt-bad": metadata key "not a key" is invalid')) {
    throw new Error(`the server with an invalid metadata key did not name it: ${stderr}`)
  }
}

type Collected = {
  body: string
  bytes: number
  hasHeaders: boolean
  atMs: number
  error?: { code: string; description: string }
}
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
      const code = message.headers?.get('Nats-Service-Error-Code')
      const chunk: Collected = {
        body: bytes === 0 ? '' : new TextDecoder().decode(message.data),
        bytes,
        hasHeaders: !!message.headers,
        atMs: Date.now(),
        ...(code ? { error: { code, description: message.headers!.get('Nats-Service-Error') } } : {}),
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

// Claude Code asking for permission: the notification it sends, and the
// decision the channel sends back, with how long that took.
let permissionCounter = 0
async function askPermission(tool = 'Bash'): Promise<{ behavior: string; ms: number }> {
  const id = `permission-${++permissionCounter}`
  const result = new Promise<string>(resolve => permissionResults.set(id, resolve))
  const started = Date.now()
  await mcp.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: id, tool_name: tool, description: 'run a command', input_preview: 'pwd' },
  })
  const behavior = await result
  permissionResults.delete(id)
  return { behavior, ms: Date.now() - started }
}
// A tool call in the turn `promptId`, as the PreToolUse hook records it.
let toolUseCounter = 0
async function toolCall(promptId: string, tool = 'Bash'): Promise<void> {
  await runHook({
    hook_event_name: 'PreToolUse',
    session_id: SESSION_ID,
    prompt_id: promptId,
    tool_use_id: `toolu_rt_turn_${++toolUseCounter}`,
    tool_name: tool,
    tool_input: { command: 'pwd' },
  })
}
// A turn's end with nothing left in the background: Claude Code is quiet.
// `extra` adds Claude Code's other Stop fields (`stop_hook_active`,
// `last_assistant_message`); returns what the hook printed.
async function turnStop(extra: Record<string, unknown> = {}): Promise<string> {
  return runHook({ hook_event_name: 'Stop', session_id: SESSION_ID, background_tasks: [], session_crons: [], ...extra })
}
// A turn's end with a background task still running: another turn may follow.
async function turnStopWithBackground(): Promise<void> {
  await runHook({ hook_event_name: 'Stop', session_id: SESSION_ID, background_tasks: [{ id: 'bg-1' }], session_crons: [] })
}
const answerQueries = (answer: string) => (chunk: Collected): void => {
  if (chunk.bytes === 0 || chunk.hasHeaders) return
  const value = parsed(chunk)
  if (value.type !== 'query') return
  const data = value.data as { reply_subject?: string }
  if (data.reply_subject) nc.publish(data.reply_subject, answer)
}
const hasQuery = (chunks: Collected[]): boolean => chunks.some(chunk => chunk.body.includes('"type":"query"'))

console.log('\n[case 4] a question during a turn goes to that turn\'s caller as a protocol query')
{
  await turnStop()
  let asked: { behavior: string; ms: number } | undefined
  currentCase = {
    replyHandler: async requestId => {
      await toolCall('prompt-4')
      asked = await askPermission()
      await mcp.callTool({ name: 'reply', arguments: { request_id: requestId, text: 'allowed' } })
      await turnStop()
    },
  }
  const chunks = await collectChunks('please inspect the directory', answerQueries('yes'))
  assertAck(chunks[0])
  if (asked?.behavior !== 'allow') fail(`permission result was ${asked?.behavior || 'missing'}`)
  if (!hasQuery(chunks)) fail('no query chunk received')
}

console.log('\n[case 4b] a question after the turn\'s request finished is denied at once')
{
  await turnStop()
  let asked: Promise<{ behavior: string; ms: number }> | undefined
  currentCase = {
    replyHandler: async requestId => {
      await toolCall('prompt-4b')
      await mcp.callTool({ name: 'reply', arguments: { request_id: requestId, text: 'done early' } })
      // The turn goes on after the reply and asks.
      asked = askPermission()
    },
  }
  const chunks = await collectChunks('finish, then keep working', answerQueries('yes'))
  // The terminator can overtake the reply call's own return.
  for (let i = 0; i < 100 && !asked; i++) await Bun.sleep(20)
  const result = await asked
  if (result?.behavior !== 'deny') fail(`a question after the reply got ${result?.behavior || 'nothing'}`)
  if ((result?.ms ?? Infinity) > 2000) fail(`the finished request's question waited ${result?.ms} ms`)
  if (hasQuery(chunks)) fail('the finished request\'s caller was asked')
  await turnStop()
}

console.log('\n[case 4c] a turn that goes on after its Stop asks nobody, not a newer prompt')
{
  await turnStop()
  let first: string | undefined
  let asked: { behavior: string; ms: number } | undefined
  let releaseFirst!: () => void
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve })
  let secondDelivered!: (requestId: string) => void
  const second = new Promise<string>(resolve => { secondDelivered = resolve })
  currentCase = {
    replyHandler: async (requestId, _meta, content) => {
      if (content === 'the newer prompt') {
        secondDelivered(requestId)
        return
      }
      first = requestId
      await toolCall('prompt-4c')
      // The turn ends with the request still open and a background task
      // running, which starts another turn; a newer prompt arrives while it runs.
      await turnStopWithBackground()
      await toolCall('prompt-4c-background')
      releaseFirst()
    },
  }
  const firstChunks = collectChunks('the older prompt', answerQueries('yes'))
  await firstReleased
  const secondChunks = collectChunks('the newer prompt', answerQueries('yes'))
  const secondId = await second
  asked = await askPermission()
  if (asked.behavior !== 'deny') fail(`the background turn's question got ${asked.behavior}`)
  if (asked.ms > 2000) fail(`the background turn's question waited ${asked.ms} ms`)
  await mcp.callTool({ name: 'reply', arguments: { request_id: secondId, text: 'second' } })
  await mcp.callTool({ name: 'reply', arguments: { request_id: first!, text: 'first' } })
  if (hasQuery(await secondChunks)) fail('the newer prompt received the older turn\'s question')
  if (hasQuery(await firstChunks)) fail('the older prompt was asked after its turn\'s Stop')
  await turnStop()
}

console.log('\n[case 4d] a caller that disconnects has its open question denied at once')
{
  await turnStop()
  const callerNc = await connect({ servers: NATS_URL, name: 'claude-channel-roundtrip-caller' })
  let asked: { behavior: string; ms: number } | undefined
  let answeredAt = 0
  let goneAt = 0
  currentCase = {
    replyHandler: async requestId => {
      await toolCall('prompt-4d')
      asked = await askPermission()
      answeredAt = Date.now()
      await mcp.callTool({ name: 'reply', arguments: { request_id: requestId, text: 'nobody to tell' } })
      await turnStop()
    },
  }
  const inbox = `_INBOX.rt.${Math.random().toString(36).slice(2, 10)}`
  const sub = callerNc.subscribe(inbox)
  const reading = (async () => {
    for await (const message of sub) {
      if (message.data.byteLength > 0 && new TextDecoder().decode(message.data).includes('"type":"query"')) {
        goneAt = Date.now()
        await callerNc.close()
        return
      }
    }
  })()
  callerNc.publish(SUBJECT, 'ask me, then leave', { reply: inbox })
  await callerNc.flush()
  await reading
  for (let i = 0; i < 200 && !asked; i++) await Bun.sleep(50)
  if (asked?.behavior !== 'deny') fail(`the gone caller's question got ${asked?.behavior || 'nothing'}`)
  // The presence check runs every 2 s; the 120 s timeout plays no part.
  const afterGone = goneAt > 0 && answeredAt > 0 ? answeredAt - goneAt : Infinity
  if (afterGone > 5000) fail(`the gone caller's question closed ${afterGone} ms after the disconnect`)
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

const TURN_END = 'the Claude Code turn ended without a reply to this prompt'
function assertTurnEnd(chunks: Collected[], label: string): void {
  assertAck(chunks[0])
  const error = chunks.find(chunk => chunk.error)?.error
  if (error?.code !== '500' || error.description !== TURN_END) {
    fail(`${label}: the error frame was ${JSON.stringify(error)}`)
  }
  if (chunks.some(chunk => chunk.body.includes('"type":"response"'))) fail(`${label}: a response chunk was sent`)
  const term = chunks.at(-1)!
  if (term.bytes !== 0 || term.hasHeaders) fail(`${label}: the stream lacks a clean terminator`)
}
async function promptEndedEvent(requestId: string): Promise<ExtensionEvent | undefined> {
  for (let i = 0; i < 40; i++) {
    const ended = extensionEvents().find(e => e.event === 'promptEnded' && e.id === requestId)
    if (ended) return ended
    await Bun.sleep(50)
  }
  return undefined
}
async function promptEndedOutcome(requestId: string): Promise<unknown> {
  return (await promptEndedEvent(requestId))?.outcome
}
// The hook refused the stop, naming the request; `''` means it let it be.
function assertRefused(printed: string, requestId: string, label: string): void {
  let decision: { decision?: unknown; reason?: unknown } = {}
  try {
    decision = JSON.parse(printed) as typeof decision
  } catch {
    return fail(`${label}: the hook did not refuse the stop (printed ${JSON.stringify(printed)})`)
  }
  if (decision.decision !== 'block' || typeof decision.reason !== 'string' || !decision.reason.includes(`"${requestId}"`)) {
    fail(`${label}: the refusal was ${printed}`)
  }
}
// The served prompt is still open: request_info still answers for it.
async function stillOpen(requestId: string): Promise<boolean> {
  const info = await mcp.callTool({ name: 'request_info', arguments: { request_id: requestId } })
  return !info.isError
}

console.log('\n[case 7] a turn that stops without the reply is refused once, then answered with its final text')
{
  await turnStop()
  let requestId = ''
  currentCase = {
    replyHandler: async id => {
      requestId = id
      await toolCall('prompt-7')
      // The model writes its answer as plain text and stops without calling reply.
      const first = await turnStop({ last_assistant_message: 'the answer, as plain text' })
      assertRefused(first, id, 'the first stop')
      await Bun.sleep(1500)
      if (!(await stillOpen(id))) fail('the prompt was ended at a refused stop')
      // The nudged turn stops again, still without reply.
      const second = await turnStop({ stop_hook_active: true, last_assistant_message: 'the answer, as plain text' })
      if (second !== '') fail(`the stop after a refusal was refused again: ${second}`)
    },
  }
  const chunks = await collectChunks('check this and answer in plain text')
  assertAck(chunks[0])
  if (chunks.some(chunk => chunk.error)) fail('the final-text prompt got an error frame')
  const responses = chunks.filter(chunk => chunk.bytes > 0 && !chunk.hasHeaders).map(parsed).filter(v => v.type === 'response')
  if (responses.length !== 1 || responses[0]!.data !== 'the answer, as plain text') {
    fail(`the caller got ${JSON.stringify(responses)}, not the final text`)
  }
  const term = chunks.at(-1)!
  if (term.bytes !== 0 || term.hasHeaders) fail('the final-text stream lacks a clean terminator')
  const ended = await promptEndedEvent(requestId)
  if (ended?.outcome !== 'ok' || ended.reason !== 'final_text') fail(`promptEnded was ${JSON.stringify(ended)}`)
}

console.log('\n[case 7b] a nudged turn that stops with no final text ends its prompt with an error')
{
  await turnStop()
  let requestId = ''
  let stoppedAt = 0
  currentCase = {
    replyHandler: async id => {
      requestId = id
      await toolCall('prompt-7b')
      assertRefused(await turnStop(), id, 'the first stop')
      // Stops again with no text at all (nor a transcript to read it from).
      stoppedAt = Date.now()
      await turnStop({ stop_hook_active: true })
    },
  }
  const chunks = await collectChunks('check this and forget to reply')
  assertTurnEnd(chunks, 'the owned prompt')
  const endedAfter = (chunks.find(chunk => chunk.error)?.atMs ?? Infinity) - stoppedAt
  if (endedAfter > 3000) fail(`the owned prompt ended ${endedAfter} ms after its Stop`)
  const ended = await promptEndedEvent(requestId)
  if (ended?.outcome !== 'error' || ended.reason !== 'no_reply') fail(`promptEnded was ${JSON.stringify(ended)}`)
  const late = await mcp.callTool({ name: 'reply', arguments: { request_id: requestId, text: 'too late' } })
  if (!late.isError) fail('a reply after the turn ended was accepted')
}

console.log('\n[case 7c] a turn that called reply is not refused, and its end carries no reason')
{
  await turnStop()
  let requestId = ''
  let printed: string | undefined
  currentCase = {
    replyHandler: async id => {
      requestId = id
      await toolCall('prompt-7c')
      await mcp.callTool({ name: 'reply', arguments: { request_id: id, text: 'answered' } })
      printed = await turnStop({ last_assistant_message: 'done' })
    },
  }
  const chunks = await collectChunks('answer properly')
  if (chunks.some(chunk => chunk.error)) fail('the answered prompt got an error frame')
  for (let i = 0; i < 40 && printed === undefined; i++) await Bun.sleep(50)
  if (printed !== '') fail(`the stop of an answered turn was refused: ${String(printed)}`)
  const ended = await promptEndedEvent(requestId)
  if (ended?.outcome !== 'ok' || ended.reason !== null) fail(`promptEnded was ${JSON.stringify(ended)}`)
}

console.log('\n[case 8] a prompt delivered during a turn survives its Stop and ends at the grace period')
{
  await turnStop()
  let firstId = ''
  let secondId = ''
  let turnRunning!: () => void
  const running = new Promise<void>(resolve => { turnRunning = resolve })
  let secondDelivered!: () => void
  const delivered = new Promise<void>(resolve => { secondDelivered = resolve })
  currentCase = {
    replyHandler: async (id, _meta, content) => {
      if (content === 'the prompt that arrives mid-turn') {
        secondId = id
        secondDelivered()
        return
      }
      firstId = id
      await toolCall('prompt-8')
      turnRunning()
    },
  }
  const firstChunks = collectChunks('the prompt that owns the turn')
  await running
  const secondChunks = collectChunks('the prompt that arrives mid-turn')
  await delivered
  await mcp.callTool({ name: 'reply', arguments: { request_id: firstId, text: 'first answered' } })
  const stoppedAt = Date.now()
  await turnStop()
  if ((await firstChunks).some(chunk => chunk.error)) fail('the answered prompt got an error frame')
  // Past the Stop, inside the grace period: still open.
  await Bun.sleep(1000)
  const early = await mcp.callTool({ name: 'request_info', arguments: { request_id: secondId } })
  if (early.isError) fail('the mid-turn prompt was ended at the Stop')
  const chunks = await secondChunks
  assertTurnEnd(chunks, 'the mid-turn prompt')
  const endedAfter = (chunks.find(chunk => chunk.error)?.atMs ?? 0) - stoppedAt
  if (endedAfter < TURN_START_GRACE_MS - 500 || endedAfter > TURN_START_GRACE_MS + 3000) {
    fail(`the mid-turn prompt ended ${endedAfter} ms after the Stop (grace ${TURN_START_GRACE_MS} ms)`)
  }
  const outcome = await promptEndedOutcome(secondId)
  if (outcome !== 'error') fail(`promptEnded for the mid-turn prompt was ${String(outcome)}`)
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

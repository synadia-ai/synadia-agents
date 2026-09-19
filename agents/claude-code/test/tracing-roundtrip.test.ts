/**
 * Tracing wiring against the shared operator fixture and the committed
 * runtime bundle: a signed, tracing-enabled cache copy of the plugin serves
 * a traced caller's prompt and publishes the served pair that binds the
 * caller's thread to the Claude Code session; the SessionStart hook moves
 * the binding to a new session id; an untraced caller gets a minted
 * thread; a turn cut short ends with `error`; tracing without identity
 * publishes nothing; shutdown removes the session file.
 *
 * Skipped without a `nats-server` binary on PATH. Run `bun run build`
 * first: like the roundtrip scripts, it drives `runtime/server.js`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { connect, type Msg, type NatsConnection } from '@nats-io/transport-node'
import {
  Agents,
  decodeHeartbeatPayload,
  parseSenderHeader,
  readSenderHeaderValue,
  resolveNatsConnectionBundle,
  verifySender,
} from '@synadia-ai/agents'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from '../../../client-sdk/typescript/test/harness/nats-server.js'
import { sessionFilePath } from '../src/session-id.js'

const OWNER = 'tracing-test'
const SESSION_A = '11111111-aaaa-4bbb-8ccc-dddddddddddd'
const SESSION_B = '22222222-aaaa-4bbb-8ccc-dddddddddddd'
const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const hasNatsServer = (await findNatsServerBinary()) !== null

type Record_ = Record<string, unknown>
const decode = (m: Msg): Record_ => JSON.parse(new TextDecoder().decode(m.data)) as Record_

describe.skipIf(!hasNatsServer)('tracing roundtrip', () => {
  const server = new NatsServerProcess()
  const cacheRoot = mkdtempSync(join(tmpdir(), 'claude-plugin-tracing-cache-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'claude-channel-tracing-state-'))
  const testHome = mkdtempSync(join(tmpdir(), 'claude-channel-tracing-home-'))
  const plugins: Client[] = []
  let nc: NatsConnection
  let callerBundle: Awaited<ReturnType<typeof resolveNatsConnectionBundle>>
  let tracedCaller: Agents
  let untracedCaller: Agents

  // The plugin's hook, run as Claude Code would run it for this test process.
  function runHook(payload: Record<string, unknown>) {
    return spawnSync('bun', [join(sourceRoot, 'hooks', 'session-event.ts')], {
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PID: String(process.pid), NATS_STATE_DIR: stateDir, NATS_TRACING: 'on' },
      encoding: 'utf8',
    })
  }

  // What the fake Claude Code does with a delivered prompt: reply, then end
  // its turn through the Stop hook, as the real one would; or leave it open.
  let hooksInstalled = false
  let onPrompt: (mcp: Client, requestId: string, content: string) => Promise<void> = async (
    mcp,
    requestId,
    content,
  ) => {
    await mcp.callTool({ name: 'reply', arguments: { request_id: requestId, text: `echo: ${content}` } })
    if (hooksInstalled) {
      // The closing model call comes after the reply; the Stop follows it.
      await Bun.sleep(1_100)
      runHook({ session_id: SESSION_B, hook_event_name: 'Stop', stop_hook_active: false })
    }
  }

  async function startPlugin(name: string, env: Record<string, string>): Promise<Client> {
    const childEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'NATS_URL' && key !== 'CLAUDE_CODE_SESSION_ID') {
        childEnv[key] = value
      }
    }
    Object.assign(
      childEnv,
      {
        // This test process stands in for Claude Code: its pid keys the hook files.
        CLAUDE_PID: String(process.pid),
        HOME: testHome,
        CLAUDE_CWD: '/tmp/tracing-host',
        NATS_CONFIG_HOME: join(testHome, '.config', 'nats'),
        NATS_CONTEXT: 'alice',
        NATS_SESSION_NAME: name,
        NATS_STATE_DIR: stateDir,
        NATS_MIN_SENDER_TRUST: 'any',
        NATS_TRACING: 'on',
        SYNADIA_CLAUDE_CODE_OWNER: OWNER,
      },
      env,
    )
    const transport = new StdioClientTransport({
      command: 'bun',
      args: [join(cacheRoot, 'runtime', 'server.js')],
      env: childEnv,
    })
    const mcp = new Client({ name: `fake-claude-${name}`, version: '0.0.1' })
    mcp.fallbackNotificationHandler = async notification => {
      if (notification.method !== 'notifications/claude/channel') return
      const params = notification.params as { content: string; meta: Record<string, unknown> }
      // Trace ids must never become model-visible channel attributes.
      expect(Object.keys(params.meta).sort()).toEqual(['request_id', 'session', 'ts'])
      await onPrompt(mcp, String(params.meta.request_id), params.content)
    }
    await mcp.connect(transport)
    plugins.push(mcp)
    return mcp
  }

  async function discoverHost(caller: Agents, name: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const [host] = await caller.discover({
        timeoutMs: 100,
        filter: { agent: 'claude-code', owner: OWNER, name },
      })
      if (host) return host
    }
    throw new Error(`plugin ${name} did not register`)
  }

  /** Collect every record on TRACE.edges published while `run` executes, plus a grace period. */
  async function collectRecords(run: () => Promise<void>): Promise<Msg[]> {
    const records: Msg[] = []
    const sub = nc.subscribe('TRACE.edges')
    const collecting = (async () => {
      for await (const m of sub) records.push(m)
    })()
    await nc.flush()
    try {
      await run()
      await Bun.sleep(hooksInstalled ? 1_800 : 300)
    } finally {
      sub.unsubscribe()
      await collecting.catch(() => undefined)
    }
    return records
  }

  async function promptAndCollect(caller: Agents, name: string, text: string): Promise<Msg[]> {
    return collectRecords(async () => {
      const host = await discoverHost(caller, name)
      let response = ''
      for await (const message of await host.prompt(text)) {
        if (message.type === 'response') response += message.text
      }
      expect(response).toBe(`echo: ${text}`)
    })
  }

  async function expectSignedByHost(m: Msg, edgeAgent: unknown): Promise<void> {
    const record = decode(m)
    const header = parseSenderHeader(readSenderHeaderValue(m.headers) ?? '')
    expect(header?.nonce).toBe(record.record_id as string)
    expect(m.headers?.get('Nats-Msg-Id')).toBe(record.record_id as string)
    const sender = await verifySender(m, 'stored')
    expect(sender?.trust).toBe('verified')
    if (sender && 'id' in sender) expect(sender.id).toBe(record.agent as string)
    expect(record.agent).not.toBe(edgeAgent)
  }

  beforeAll(async () => {
    mkdirSync(join(cacheRoot, '.claude-plugin'), { recursive: true })
    mkdirSync(join(cacheRoot, 'runtime'), { recursive: true })
    copyFileSync(
      join(sourceRoot, '.claude-plugin', 'plugin.json'),
      join(cacheRoot, '.claude-plugin', 'plugin.json'),
    )
    copyFileSync(join(sourceRoot, 'runtime', 'server.js'), join(cacheRoot, 'runtime', 'server.js'))

    await server.start({ configPath: identityFixture('operator/operator.conf') })
    const contextDir = join(testHome, '.config', 'nats', 'context')
    mkdirSync(contextDir, { recursive: true })
    await Bun.write(
      join(contextDir, 'alice.json'),
      JSON.stringify({ url: server.url, creds: identityFixture('operator/alice.creds') }),
    )

    callerBundle = await resolveNatsConnectionBundle(
      { url: server.url, creds: identityFixture('operator/carol.creds') },
      { identity: 'signed' },
    )
    nc = await connect(callerBundle.connectionOptions)
    tracedCaller = new Agents({
      nc,
      identity: { signer: callerBundle.signer!, name: 'tracing-test-caller' },
      trace: {},
    })
    untracedCaller = new Agents({ nc })
  }, 30_000)

  afterAll(async () => {
    for (const mcp of plugins) await mcp.close().catch(() => undefined)
    await tracedCaller?.close().catch(() => undefined)
    await untracedCaller?.close().catch(() => undefined)
    await nc?.drain().catch(() => undefined)
    callerBundle?.wipe()
    await server.stop().catch(() => undefined)
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(cacheRoot, { recursive: true, force: true })
    rmSync(testHome, { recursive: true, force: true })
  })

  test('signed + tracing on: the served pair binds the caller\'s thread to the session', async () => {
    await startPlugin('traced', { NATS_SENDER_IDENTITY: 'signed', CLAUDE_CODE_SESSION_ID: SESSION_A })
    const records = await promptAndCollect(tracedCaller, 'traced', 'hello traced')
    expect(records.map(m => decode(m).kind)).toEqual(['edge', 'served', 'served'])
    const [edge, start, end] = records.map(decode) as [Record_, Record_, Record_]
    expect(start).toMatchObject({
      version: 1,
      kind: 'served',
      phase: 'start',
      harness: 'claude',
      harness_thread_id: SESSION_A,
      thread_id: edge.thread_id,
      root_id: edge.root_id,
    })
    expect(start.status).toBeUndefined()
    expect(end).toMatchObject({
      phase: 'end',
      status: 'ok',
      harness_thread_id: SESSION_A,
      thread_id: edge.thread_id,
      root_id: edge.root_id,
    })
    expect(end.ts as number).toBeGreaterThanOrEqual(start.ts as number)
    for (const m of records.slice(1)) await expectSignedByHost(m, edge.agent)

    // The heartbeat reports the two records this process published.
    const host = await discoverHost(tracedCaller, 'traced')
    const status = await nc.request(`agents.status.cc.${OWNER}.traced`, '', { timeout: 2000 })
    const beat = decodeHeartbeatPayload(status.json())
    expect(beat?.extras).toMatchObject({ records_published: 2, records_dropped: 0 })
    expect(host.name).toBe('traced')
  }, 30_000)

  test('the SessionStart hook moves the binding to the new session id', async () => {
    const hook = runHook({ session_id: SESSION_B, hook_event_name: 'SessionStart', source: 'clear' })
    expect(hook.status).toBe(0)
    expect(hook.stdout).toBe('')
    expect(existsSync(sessionFilePath(stateDir, process.pid))).toBe(true)
    hooksInstalled = true

    // With hooks active, `end` waits for the Stop the fake Claude fires after
    // its reply, so the window covers the turn's closing call.
    const repliedAt = Math.floor(Date.now() / 1000)
    const records = await promptAndCollect(tracedCaller, 'traced', 'hello again')
    const served = records.map(decode).filter(r => r.kind === 'served')
    expect(served).toHaveLength(2)
    for (const record of served) expect(record.harness_thread_id).toBe(SESSION_B)
    const [start, end] = served as [Record_, Record_]
    expect(end.phase).toBe('end')
    expect((end.ts as number) - (start.ts as number)).toBeGreaterThanOrEqual(1)
    expect(end.ts as number).toBeGreaterThanOrEqual(repliedAt + 1)
  }, 30_000)

  test('an untraced caller gets a minted thread: a served pair and no edge', async () => {
    const records = await promptAndCollect(untracedCaller, 'traced', 'hello untraced')
    expect(records.map(m => decode(m).kind)).toEqual(['served', 'served'])
    const [start, end] = records.map(decode) as [Record_, Record_]
    expect(start.thread_id).toMatch(/^[0-9a-f]{32}$/)
    expect(start.root_id).toBe(start.thread_id)
    expect(end.thread_id).toBe(start.thread_id)
  }, 30_000)

  test('tracing on without identity publishes no records, counts them dropped, still serves', async () => {
    await startPlugin('unsigned', { NATS_SENDER_IDENTITY: 'off', CLAUDE_CODE_SESSION_ID: SESSION_A })
    const records = await promptAndCollect(tracedCaller, 'unsigned', 'hello unsigned')
    expect(records.map(m => decode(m).kind)).toEqual(['edge'])
    const status = await nc.request(`agents.status.cc.${OWNER}.unsigned`, '', { timeout: 2000 })
    expect(decodeHeartbeatPayload(status.json())?.extras).toMatchObject({
      records_published: 0,
      records_dropped: 2,
    })
  }, 30_000)

  test('a prompt that fails before Claude sees it closes its window with error', async () => {
    // Staging an attachment needs a writable attachments dir; take it away.
    const attachments = join(stateDir, 'attachments')
    chmodSync(attachments, 0o500)
    try {
      const records = await collectRecords(async () => {
        const host = await discoverHost(tracedCaller, 'traced')
        let failed = false
        try {
          const stream = await host.prompt('with a file', {
            attachments: [{ filename: 'a.txt', content: new TextEncoder().encode('x') }],
          })
          for await (const _ of stream) {
            // the 500 ends the stream
          }
        } catch {
          failed = true
        }
        expect(failed).toBe(true)
      })
      const served = records.map(decode).filter(r => r.kind === 'served')
      expect(served.map(r => r.phase)).toEqual(['start', 'end'])
      expect(served[1]!.status).toBe('error')
    } finally {
      chmodSync(attachments, 0o700)
    }
  }, 30_000)

  test('a turn cut short by shutdown ends with error; a live Claude Code keeps its files', async () => {
    const mcp = await startPlugin('cut', { NATS_SENDER_IDENTITY: 'signed', CLAUDE_CODE_SESSION_ID: SESSION_A })
    // Hold the prompt open; the shutdown below ends it without an answer.
    let delivered!: () => void
    const deliveredPromise = new Promise<void>(resolve => (delivered = resolve))
    onPrompt = async () => delivered()

    const records = await collectRecords(async () => {
      const host = await discoverHost(tracedCaller, 'cut')
      // The request goes out when the stream is first iterated, so consume
      // it in the background and wait for the plugin to hand it to Claude.
      const failed = (async () => {
        try {
          for await (const _ of await host.prompt('never answered')) {
            // consume until the error frame ends the stream
          }
          return false
        } catch {
          return true
        }
      })()
      await deliveredPromise
      await mcp.close()
      plugins.splice(plugins.indexOf(mcp), 1)
      expect(await failed).toBe(true)
    })
    const served = records.map(decode).filter(r => r.kind === 'served')
    expect(served.map(r => r.phase)).toEqual(['start', 'end'])
    expect(served[1]!.status).toBe('error')
    // The files belong to the Claude Code process (this test), which is
    // alive: a restarted server must still find them.
    expect(existsSync(sessionFilePath(stateDir, process.pid))).toBe(true)
  }, 30_000)
})

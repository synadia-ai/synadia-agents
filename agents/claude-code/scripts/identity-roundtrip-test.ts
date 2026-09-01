#!/usr/bin/env bun
/** Signed-host and strict-admission wiring test against the shared operator fixture. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  Agents,
  resolveNatsConnectionBundle,
} from '@synadia-ai/agents'
import { connect } from '@nats-io/transport-node'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  identityFixture,
  NatsServerProcess,
} from '../../../client-sdk/typescript/test/harness/nats-server.js'

const OWNER = 'identity-test'
const NAME = 'signed-host'
const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cacheRoot = mkdtempSync(join(tmpdir(), 'claude-plugin-signed-cache-'))
const stateDir = mkdtempSync(join(tmpdir(), 'claude-channel-signed-state-'))
const testHome = mkdtempSync(join(tmpdir(), 'claude-channel-signed-home-'))
const server = new NatsServerProcess()

mkdirSync(join(cacheRoot, '.claude-plugin'), { recursive: true })
mkdirSync(join(cacheRoot, 'runtime'), { recursive: true })
copyFileSync(
  join(sourceRoot, '.claude-plugin', 'plugin.json'),
  join(cacheRoot, '.claude-plugin', 'plugin.json'),
)
copyFileSync(join(sourceRoot, 'runtime', 'server.js'), join(cacheRoot, 'runtime', 'server.js'))

let mcp: Client | undefined
let nc: Awaited<ReturnType<typeof connect>> | undefined
let callerBundle: Awaited<ReturnType<typeof resolveNatsConnectionBundle>> | undefined
let signedAgents: Agents | undefined
let unsignedAgents: Agents | undefined

try {
  await server.start({ configPath: identityFixture('operator/operator.conf') })
  const configHome = join(testHome, '.config', 'nats')
  const contextDir = join(configHome, 'context')
  mkdirSync(contextDir, { recursive: true })
  await Bun.write(join(contextDir, 'alice.json'), JSON.stringify({
    url: server.url,
    creds: identityFixture('operator/alice.creds'),
  }))

  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'NATS_URL') childEnv[key] = value
  }
  Object.assign(childEnv, {
    HOME: testHome,
    CLAUDE_CWD: '/tmp/signed-host',
    NATS_CONFIG_HOME: configHome,
    NATS_CONTEXT: 'alice',
    NATS_SESSION_NAME: NAME,
    NATS_STATE_DIR: stateDir,
    NATS_SENDER_IDENTITY: 'signed',
    NATS_MIN_SENDER_TRUST: 'signed',
    SYNADIA_CLAUDE_CODE_OWNER: OWNER,
  })

  const transport = new StdioClientTransport({
    command: 'bun',
    args: [join(cacheRoot, 'runtime', 'server.js')],
    env: childEnv,
  })
  mcp = new Client({ name: 'fake-claude-identity', version: '0.0.1' })
  let delivered = 0
  let senderInfo = ''
  mcp.fallbackNotificationHandler = async notification => {
    if (notification.method !== 'notifications/claude/channel') return
    delivered++
    const params = notification.params as {
      content: string
      meta: Record<string, unknown>
    }
    if ('sender' in params.meta || 'identity' in params.meta || 'trust' in params.meta) {
      throw new Error('sender leaked into model-visible channel metadata')
    }
    if (params.content !== 'signed hello') throw new Error('signed prompt content changed')
    const requestId = String(params.meta.request_id)
    const info = await mcp!.callTool({
      name: 'request_info',
      arguments: { request_id: requestId },
    })
    senderInfo = info.content[0]?.type === 'text' ? info.content[0].text : ''
    await mcp!.callTool({
      name: 'reply',
      arguments: { request_id: requestId, text: 'signed response' },
    })
  }
  await mcp.connect(transport)

  callerBundle = await resolveNatsConnectionBundle(
    { url: server.url, creds: identityFixture('operator/carol.creds') },
    { identity: 'signed' },
  )
  nc = await connect(callerBundle.connectionOptions)
  signedAgents = new Agents({
    nc,
    identity: { signer: callerBundle.signer!, name: 'identity-test-caller' },
  })
  unsignedAgents = new Agents({ nc })

  let signedHost: Awaited<ReturnType<Agents['discover']>>[number] | undefined
  for (let attempt = 0; attempt < 20 && !signedHost; attempt++) {
    signedHost = (await signedAgents.discover({
      timeoutMs: 100,
      filter: { agent: 'claude-code', owner: OWNER, name: NAME },
    }))[0]
  }
  if (!signedHost) throw new Error('signed cached plugin did not register')
  if (!signedHost.identity || !signedHost.idSigVerified) {
    throw new Error('signed host registration identity did not verify')
  }
  if (signedHost.minSenderTrust !== 'signed') {
    throw new Error('signed-only admission was not advertised')
  }

  const headerlessInbox = `_INBOX.strict.${Math.random().toString(36).slice(2)}`
  const headerlessSub = nc.subscribe(headerlessInbox)
  const refused: Array<{ body: string; code?: string; hasHeaders: boolean }> = []
  const refusal = (async () => {
    for await (const message of headerlessSub) {
      refused.push({
        body: message.string(),
        code: message.headers?.get('Nats-Service-Error-Code') || undefined,
        hasHeaders: !!message.headers,
      })
      if (message.data.byteLength === 0 && !message.headers) break
    }
  })()
  nc.publish(signedHost.promptSubject, 'headerless', { reply: headerlessInbox })
  await nc.flush()
  await refusal
  if (refused[0]?.code !== '401') throw new Error('headerless strict prompt was not rejected 401')
  if (refused.some(message => message.body.includes('"status"'))) {
    throw new Error('strict rejection emitted an acknowledgement')
  }
  if (delivered !== 0) throw new Error('strict rejection reached the MCP/model handler')

  const [unsignedHandle] = await unsignedAgents.discover({
    timeoutMs: 300,
    filter: { agent: 'claude-code', owner: OWNER, name: NAME },
  })
  if (!unsignedHandle) throw new Error('unsigned status probe could not discover host')
  await unsignedHandle.status({ timeoutMs: 1000 })

  let response = ''
  for await (const message of await signedHost.prompt('signed hello')) {
    if (message.type === 'response') response += message.text
  }
  if (response !== 'signed response') throw new Error('signed prompt response mismatch')
  if (delivered !== 1) throw new Error(`expected one MCP delivery, got ${delivered}`)
  if (!senderInfo.includes('(verified user, claimed account)')) {
    throw new Error('request_info did not report the verified sender')
  }

  console.log('SIGNED IDENTITY PASS')
} finally {
  await mcp?.close().catch(() => undefined)
  await signedAgents?.close().catch(() => undefined)
  await unsignedAgents?.close().catch(() => undefined)
  await nc?.drain().catch(() => undefined)
  callerBundle?.wipe()
  await server.stop().catch(() => undefined)
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cacheRoot, { recursive: true, force: true })
  rmSync(testHome, { recursive: true, force: true })
}

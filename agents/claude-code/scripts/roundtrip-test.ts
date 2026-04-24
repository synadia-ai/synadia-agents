#!/usr/bin/env bun
/**
 * End-to-end roundtrip tests. Spawns server.ts as a subprocess, fakes the
 * Claude Code MCP client side, and drives the NATS side directly.
 *
 * Cases covered:
 *   1. basic request → two typed response chunks → terminator
 *   2. JSON envelope with an attachment → file is staged, path reaches Claude
 *   3. large response → server splits into multiple chunks, all under max_payload
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { connect } from '@nats-io/transport-node'
import { readFileSync, rmSync, existsSync } from 'fs'

const SUBJECT = 'agents.cc.m64.rt-test'
const STATE_DIR = '/tmp/rt-test-state'
const MAX_PAYLOAD = 1024 * 1024

rmSync(STATE_DIR, { recursive: true, force: true })
Bun.write(`${STATE_DIR}/config.json`, JSON.stringify({ context: 'localhost' }))

const nc = await connect({ servers: 'nats://localhost:4222', name: 'rt-test-probe' })

const transport = new StdioClientTransport({
  command: 'bun',
  args: ['--bun', new URL('../server.ts', import.meta.url).pathname],
  env: {
    ...process.env,
    CLAUDE_CWD: '/tmp/rt-test',
    NATS_SESSION_NAME: 'rt-test',
    NATS_STATE_DIR: STATE_DIR,
  },
})

const mcp = new Client({ name: 'fake-claude', version: '0.0.1' })

type PromptCase = {
  replyHandler: (requestId: string, meta: any, content: string) => Promise<void>
}

let currentCase: PromptCase | null = null
mcp.fallbackNotificationHandler = async (n: any) => {
  if (n.method !== 'notifications/claude/channel') return
  if (!currentCase) return
  const { meta, content } = n.params
  await currentCase.replyHandler(meta.request_id, meta, content)
}

await mcp.connect(transport)
await new Promise(r => setTimeout(r, 800))

async function collectChunks(reqBody: string | Uint8Array): Promise<
  Array<{body: string; bytes: number; hasHeaders: boolean}>
> {
  const inbox = `_INBOX.rt.${Math.random().toString(36).slice(2, 10)}`
  const sub = nc.subscribe(inbox)
  const chunks: Array<{body: string; bytes: number; hasHeaders: boolean}> = []
  const collect = (async () => {
    for await (const m of sub) {
      const bytes = m.data.byteLength
      const body = bytes === 0 ? '' : new TextDecoder().decode(m.data)
      const hasHeaders = !!m.headers
      chunks.push({ body, bytes, hasHeaders })
      if (bytes === 0 && !hasHeaders) break
    }
  })()
  nc.publish(SUBJECT, reqBody, { reply: inbox })
  await nc.flush()
  const timer = setTimeout(() => sub.unsubscribe(), 15_000)
  await collect.catch(() => undefined)
  clearTimeout(timer)
  return chunks
}

let failures = 0
function fail(msg: string): void {
  console.error(`  FAIL: ${msg}`)
  failures++
}

// ── Case 1: basic request ───────────────────────────────────────────────
{
  console.log('\n[case 1] basic prompt → two response chunks → terminator')
  currentCase = {
    replyHandler: async (requestId) => {
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
  console.log(`  received ${chunks.length} messages`)

  if (chunks.length !== 3) fail(`expected 3 messages, got ${chunks.length}`)
  try {
    const a = JSON.parse(chunks[0]!.body)
    const b = JSON.parse(chunks[1]!.body)
    if (a.type !== 'response' || a.data !== 'part one ') fail('chunk 0 shape')
    if (b.type !== 'response' || b.data !== 'part two') fail('chunk 1 shape')
  } catch (e) {
    fail(`chunk parse failed: ${e}`)
  }
  const term = chunks[chunks.length - 1]!
  if (term.bytes !== 0 || term.hasHeaders) fail('terminator must be empty + headerless')
}

// ── Case 2: attachment ──────────────────────────────────────────────────
{
  console.log('\n[case 2] JSON envelope with an attachment → file staged for Claude')
  const fileBytes = new TextEncoder().encode('hello-attachment-contents\n')
  const base64 = Buffer.from(fileBytes).toString('base64')
  const envelope = JSON.stringify({
    prompt: 'what is in this file?',
    attachments: [{ filename: 'note.txt', content: base64 }],
  })

  let stagedPath: string | undefined
  let preReplyContents: string | undefined
  currentCase = {
    replyHandler: async (requestId, meta, content) => {
      // Attachment paths arrive as a preamble in the prompt content.
      const match = /^- (\S.+)$/m.exec(content ?? '')
      if (match) {
        stagedPath = match[1]
        try {
          preReplyContents = readFileSync(stagedPath, 'utf8')
        } catch (e) {
          fail(`staged file not readable before reply: ${e}`)
        }
      }
      await mcp.callTool({
        name: 'reply',
        arguments: { request_id: requestId, text: 'ok', done: true },
      })
    },
  }
  const chunks = await collectChunks(envelope)
  if (chunks.length !== 2) fail(`expected 2 messages, got ${chunks.length}`)
  if (!stagedPath) {
    fail('no attachment path surfaced in MCP notification')
  } else {
    console.log(`  staged at ${stagedPath}`)
    if (preReplyContents !== 'hello-attachment-contents\n') {
      fail(`staged contents mismatch: ${JSON.stringify(preReplyContents)}`)
    }
    await new Promise(r => setTimeout(r, 200))
    if (existsSync(stagedPath)) fail('staged file was not cleaned up after done=true')
  }
}

// ── Case 3: large response chunking ─────────────────────────────────────
{
  console.log('\n[case 3] oversized response → split into multiple typed chunks')
  // 1.4 MB of ASCII — larger than max_payload.
  const large = 'x'.repeat(1_400_000)
  currentCase = {
    replyHandler: async (requestId) => {
      await mcp.callTool({
        name: 'reply',
        arguments: { request_id: requestId, text: large, done: true },
      })
    },
  }
  const chunks = await collectChunks('give me the payload')
  console.log(`  received ${chunks.length} messages (including terminator)`)

  // Terminator is last; each prior chunk must be a valid response envelope
  // and fit within max_payload.
  let reconstructed = ''
  for (let i = 0; i < chunks.length - 1; i++) {
    const c = chunks[i]!
    if (c.bytes > MAX_PAYLOAD) fail(`chunk ${i} exceeds max_payload (${c.bytes} > ${MAX_PAYLOAD})`)
    try {
      const obj = JSON.parse(c.body)
      if (obj.type !== 'response') fail(`chunk ${i} type not 'response'`)
      const text = typeof obj.data === 'string' ? obj.data : obj.data.text
      reconstructed += text
    } catch (e) {
      fail(`chunk ${i} not valid JSON: ${e}`)
    }
  }
  if (reconstructed !== large) {
    fail(`reconstructed length ${reconstructed.length}, expected ${large.length}`)
  }
  const term = chunks[chunks.length - 1]!
  if (term.bytes !== 0 || term.hasHeaders) fail('terminator must be empty + headerless')
}

// ── cleanup ─────────────────────────────────────────────────────────────
await mcp.close()
await nc.drain()
rmSync(STATE_DIR, { recursive: true, force: true })

console.log()
if (failures === 0) {
  console.log('ALL PASS')
  process.exit(0)
} else {
  console.error(`${failures} FAILURE(S)`)
  process.exit(1)
}

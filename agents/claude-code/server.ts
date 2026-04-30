#!/usr/bin/env bun
/**
 * NATS channel for Claude Code — spec-compliant agent for the
 * NATS Agent Protocol v0.3 (see https://github.com/synadia-ai/nats-agent-sdk-docs).
 *
 * Self-contained MCP server that registers as an `agents` micro service,
 * exposes a `prompt` endpoint on agents.prompt.cc.<owner>.<name>, publishes
 * heartbeats on agents.hb.cc.<owner>.<name> (§8.1 v0.3 verb-first), and
 * answers status requests on agents.status.cc.<owner>.<name> (§8.7 (v0.3)).
 *
 * Bridges prompt requests into the Claude Code session via MCP <channel>
 * notifications. Claude responds via the `reply` tool; each response is
 * emitted as typed JSON chunks ({type:"response", data:<text>}) terminated
 * by an empty headerless message. Permission prompts from the harness are
 * relayed as query chunks (§7) on the active stream's reply subject.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  connect,
  createInbox,
  credsAuthenticator,
  nkeyAuthenticator,
  jwtAuthenticator,
  tokenAuthenticator,
  usernamePasswordAuthenticator,
  type NatsConnection,
  type NodeConnectionOptions,
} from '@nats-io/transport-node'
import { Svcm } from '@nats-io/services'
import type { ServiceMsg } from '@nats-io/services'
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join, basename, dirname } from 'path'
import { fileURLToPath } from 'url'

// ── Constants ──────────────────────────────────────────────────────────
const PROTOCOL_VERSION = '0.3'
const AGENT_ID = 'claude-code'          // metadata.agent (canonical per Appendix C)
const AGENT_SUBJECT_TOKEN = 'cc'        // 3rd subject token (abbreviation per Appendix C)
const SERVICE_NAME = 'agents'           // §3.1 — the bare token, subject-safe as-is
const PROMPT_QUEUE_GROUP = 'agents'     // §3.3 — queue group on the prompt endpoint
const STATUS_QUEUE_GROUP = 'agents'     // §8.7 (v0.3) — same as prompt
// Fallbacks used only when the server `INFO` block is unavailable. The real
// values come from `nc.info.max_payload` after connect — that's the limit the
// server will actually accept for this user/account, so it's also what we
// advertise in endpoint metadata and enforce on inbound requests.
const DEFAULT_MAX_PAYLOAD_STR = '1MB'
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024
const ATTACHMENTS_OK = true

/** Format a byte count back into the §2.1 `\d+(B|KB|MB|GB)` grammar, base-1024. */
function formatMaxPayloadString(bytes: number): string {
  if (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3}GB`
  if (bytes >= 1024 ** 2 && bytes % 1024 ** 2 === 0) return `${bytes / 1024 ** 2}MB`
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}KB`
  return `${bytes}B`
}
const HEARTBEAT_INTERVAL_S = 30         // §8.2 recommended default
const ACK_INTERVAL_MS = 30_000          // keep-alive cadence; caller inactivity timeout is 60s
const PERMISSION_TIMEOUT_MS = 120_000   // query reply timeout for permission prompts
const REQUEST_TTL_MS = 30 * 60 * 1000

// ── State directories ──────────────────────────────────────────────────
const STATE_DIR = process.env.NATS_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'nats')
const CONFIG_FILE = join(STATE_DIR, 'config.json')
const ATTACHMENT_DIR = join(STATE_DIR, 'attachments')
const NATS_CONTEXT_DIR = join(homedir(), '.config', 'nats', 'context')

mkdirSync(ATTACHMENT_DIR, { recursive: true })

// ── Plugin version (for service.version) ───────────────────────────────
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
const PLUGIN_VERSION: string = (() => {
  try {
    const manifest = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// ── Config types ───────────────────────────────────────────────────────

type PermissionMode = 'terminal' | 'query'

type NatsChannelConfig = {
  context?: string
  sessionName?: string
  permissions?: {
    // 'nats' is accepted as a backward-compatible alias for 'query'.
    mode: PermissionMode | 'nats'
    subject?: string  // no longer used; kept so legacy configs still parse
  }
}

type NatsContext = {
  description?: string
  url?: string
  token?: string
  user?: string
  password?: string
  creds?: string
  nkey?: string
  cert?: string
  key?: string
  ca?: string
  tls_first?: boolean
  inbox_prefix?: string
  user_jwt?: string
  user_seed?: string
  socks_proxy?: string
}

const DEFAULT_CONTEXT: NatsContext = {
  url: 'demo.nats.io',
  description: 'NATS demo server (no auth)',
}

function loadConfig(): NatsChannelConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as NatsChannelConfig
  } catch {
    return {}
  }
}

function loadNatsContext(name: string): NatsContext {
  // Reject names that would escape the context directory. `$NATS_CONTEXT`
  // is set by deployers, not random users, but a clear error beats reading
  // a surprise `.json` file from `/etc`, and the cost is one guard.
  // Mirrors the validation in `agents/openclaw/src/nats/context-loader.ts`.
  if (
    !name ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name === '..' ||
    name.startsWith('.')
  ) {
    process.stderr.write(
      `nats channel: NATS context name ${JSON.stringify(name)} is invalid (must not contain path separators or start with '.')\n`,
    )
    process.exit(1)
  }
  const contextFile = join(NATS_CONTEXT_DIR, `${name}.json`)
  try {
    return JSON.parse(readFileSync(contextFile, 'utf8')) as NatsContext
  } catch {
    process.stderr.write(
      `nats channel: NATS context "${name}" not found at ${contextFile}\n` +
      `  run /nats-channel:configure to select a valid context\n`,
    )
    process.exit(1)
  }
}

// Parse a NATS URL into a partial `NodeConnectionOptions`, extracting
// credentials from `userinfo` if present. Without this, a URL like
// `nats://TOKEN@host:port` would silently drop the token because
// `@nats-io/transport-node` doesn't parse credentials from URLs (the
// `nats` CLI does, which is the UX gap this closes). Inlined per the
// repo CLAUDE.md "Agents do NOT depend on the SDK" rule —
// byte-equivalent to `@synadia-ai/agents`'s `parseNatsUrl`. Supports
// comma-separated cluster URLs (the form `@nats-io/transport-node`
// accepts via `servers: string`).
type ParsedSingle = { server: string; token?: string; user?: string; pass?: string }
function parseSingleNatsUrl(part: string, original: string): ParsedSingle {
  const withScheme = /^[a-z]+:\/\//i.test(part) ? part : `nats://${part}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch (e) {
    throw new Error(`invalid NATS URL ${JSON.stringify(original)}: ${(e as Error).message}`)
  }
  if (!/^(nats|tls|ws|wss):$/.test(parsed.protocol)) {
    throw new Error(`unsupported scheme "${parsed.protocol}" in NATS URL ${JSON.stringify(original)}`)
  }
  if (!parsed.host) {
    throw new Error(`NATS URL ${JSON.stringify(original)} is missing a host`)
  }
  const out: ParsedSingle = { server: `${parsed.protocol}//${parsed.host}` }
  // WHATWG `URL` squashes `nats://user@host` and `nats://user:@host` into
  // `password === ""`; sniff raw input for a colon to recover the intent.
  const userinfoMatch = withScheme.match(/^[a-z]+:\/\/([^/@]*)@/i)
  const hasColonSeparator = (userinfoMatch?.[1] ?? '').includes(':')
  if (hasColonSeparator) {
    out.user = decodeURIComponent(parsed.username)
    out.pass = decodeURIComponent(parsed.password)
  } else if (parsed.username !== '') {
    out.token = decodeURIComponent(parsed.username)
  }
  return out
}
function parseNatsUrl(url: string): { servers: string[]; token?: string; user?: string; pass?: string } {
  const parts = url.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  if (parts.length === 0) {
    throw new Error(`empty NATS URL: ${JSON.stringify(url)}`)
  }
  const parsedAll = parts.map((p) => parseSingleNatsUrl(p, url))
  const first = parsedAll[0]!
  // Mixed userinfo across cluster entries can't be expressed in one
  // ConnectionOptions — fail loudly rather than silently drop credentials.
  for (const p of parsedAll.slice(1)) {
    if (p.token !== first.token || p.user !== first.user || p.pass !== first.pass) {
      throw new Error(`NATS URL has mixed credentials across server entries: ${url}`)
    }
  }
  const out: { servers: string[]; token?: string; user?: string; pass?: string } = {
    servers: parsedAll.map((p) => p.server),
  }
  if (first.token !== undefined) out.token = first.token
  if (first.user !== undefined) out.user = first.user
  if (first.pass !== undefined) out.pass = first.pass
  return out
}

function contextToConnectOpts(ctx: NatsContext): NodeConnectionOptions {
  const opts: NodeConnectionOptions = {
    name: 'claude-code-nats-channel',
  }

  // Parse the URL once; extracted userinfo serves as a fallback only when
  // no explicit context-file auth field is set (precedence below).
  const urlOpts = ctx.url ? parseNatsUrl(ctx.url) : null
  if (urlOpts) {
    opts.servers = urlOpts.servers
  }

  // Auth precedence: explicit context fields > URL userinfo. So a context
  // file with `token: "abc"` wins over `url: "nats://xyz@host:port"`.
  if (ctx.creds) {
    opts.authenticator = credsAuthenticator(readFileSync(ctx.creds))
  } else if (ctx.nkey) {
    opts.authenticator = nkeyAuthenticator(readFileSync(ctx.nkey))
  } else if (ctx.user_jwt && ctx.user_seed) {
    const seed = new TextEncoder().encode(ctx.user_seed)
    opts.authenticator = jwtAuthenticator(ctx.user_jwt, seed)
  } else if (ctx.token) {
    opts.authenticator = tokenAuthenticator(ctx.token)
  } else if (ctx.user) {
    opts.authenticator = usernamePasswordAuthenticator(ctx.user, ctx.password ?? '')
  } else if (urlOpts?.token) {
    opts.authenticator = tokenAuthenticator(urlOpts.token)
  } else if (urlOpts?.user !== undefined) {
    opts.authenticator = usernamePasswordAuthenticator(urlOpts.user, urlOpts.pass ?? '')
  }

  if (ctx.cert || ctx.key || ctx.ca) {
    opts.tls = {
      certFile: ctx.cert || undefined,
      keyFile: ctx.key || undefined,
      caFile: ctx.ca || undefined,
      handshakeFirst: ctx.tls_first || undefined,
    }
  }

  if (ctx.inbox_prefix) {
    opts.inboxPrefix = ctx.inbox_prefix
  }

  return opts
}

// ── Session name resolution ────────────────────────────────────────────

function sanitizeSessionName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase().replace(/^-+|-+$/g, '')
}

async function resolveSessionName(nc: NatsConnection, base: string, owner: string): Promise<string> {
  const svcm = new Svcm(nc)
  const client = svcm.client({ maxWait: 1000, maxMessages: 50 })

  const taken = new Set<string>()
  try {
    const iter = await client.info(SERVICE_NAME)
    for await (const si of iter) {
      if (si.metadata?.agent !== AGENT_ID) continue
      if (si.metadata?.owner !== owner) continue
      for (const ep of si.endpoints ?? []) {
        // Instance name is the 5th subject token under v0.3 verb-first
        // (`agents.{verb}.{agent}.{owner}.{name}`). Pre-v0.3 was the 4th
        // token (`agents.{agent}.{owner}.{name}`) — but v0.3 is a hard
        // wire cut, so we only look at the v0.3 shape.
        const tokens = ep.subject.split('.')
        if (tokens.length >= 5) taken.add(tokens[4]!)
      }
    }
  } catch {
    // No existing services or timeout — that's fine.
  }

  let candidate = base
  let suffix = 2
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix++}`
  }
  return candidate
}

// ── Request envelope parsing (§5) ──────────────────────────────────────

type ParsedAttachment = { filename: string; bytes: Uint8Array }
type ParseResult =
  | { kind: 'ok'; prompt: string; attachments: ParsedAttachment[] }
  | { kind: 'error'; code: number; description: string }

const WHITESPACE = new Set([0x09, 0x0A, 0x0D, 0x20])
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

function parseRequest(data: Uint8Array, maxPayloadBytes: number): ParseResult {
  if (data.byteLength === 0) {
    return { kind: 'error', code: 400, description: 'empty payload' }
  }
  if (data.byteLength > maxPayloadBytes) {
    return { kind: 'error', code: 400, description: 'request exceeds max_payload' }
  }

  let start = 0
  while (start < data.byteLength && WHITESPACE.has(data[start]!)) start++
  if (start === data.byteLength) {
    return { kind: 'error', code: 400, description: 'empty payload' }
  }

  if (data[start] !== 0x7B /* '{' */) {
    // Plain-text shorthand (§5.3 step 3).
    const prompt = new TextDecoder().decode(data)
    if (prompt.length === 0) {
      return { kind: 'error', code: 400, description: 'empty payload' }
    }
    return { kind: 'ok', prompt, attachments: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(data))
  } catch {
    return { kind: 'error', code: 400, description: 'malformed JSON envelope' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'error', code: 400, description: 'envelope must be a JSON object' }
  }
  const env = parsed as Record<string, unknown>
  if (typeof env.prompt !== 'string' || env.prompt.length === 0) {
    return { kind: 'error', code: 400, description: 'envelope missing non-empty prompt string' }
  }

  const rawAttachments = env.attachments
  const attachments: ParsedAttachment[] = []
  if (rawAttachments !== undefined) {
    if (!Array.isArray(rawAttachments)) {
      return { kind: 'error', code: 400, description: 'attachments must be an array' }
    }
    for (const att of rawAttachments) {
      if (typeof att !== 'object' || att === null) {
        return { kind: 'error', code: 400, description: 'attachment must be an object' }
      }
      const a = att as Record<string, unknown>
      if (typeof a.filename !== 'string' || a.filename.length === 0) {
        return { kind: 'error', code: 400, description: 'attachment missing filename' }
      }
      if (typeof a.content !== 'string') {
        return { kind: 'error', code: 400, description: `attachment ${a.filename} missing content` }
      }
      // Strict base64 per §5.2: standard alphabet, padded, no whitespace.
      if (a.content.length % 4 !== 0 || !BASE64_PATTERN.test(a.content)) {
        return { kind: 'error', code: 400, description: `attachment ${a.filename} has invalid base64` }
      }
      let bytes: Uint8Array
      try {
        bytes = Uint8Array.from(Buffer.from(a.content, 'base64'))
      } catch {
        return { kind: 'error', code: 400, description: `attachment ${a.filename} failed to decode` }
      }
      attachments.push({ filename: a.filename, bytes })
    }
  }

  return { kind: 'ok', prompt: env.prompt, attachments }
}

// ── Attachment staging ─────────────────────────────────────────────────

type StagedAttachment = { filename: string; path: string }

function stageAttachments(requestId: string, attachments: ParsedAttachment[]): StagedAttachment[] {
  if (attachments.length === 0) return []
  const dir = join(ATTACHMENT_DIR, requestId)
  mkdirSync(dir, { recursive: true })
  const staged: StagedAttachment[] = []
  attachments.forEach((att, idx) => {
    const safeBase = basename(att.filename).replace(/^\.+/, '_')
    const safe = safeBase.length > 0 ? safeBase : `file-${idx}`
    const path = join(dir, safe)
    writeFileSync(path, att.bytes)
    staged.push({ filename: att.filename, path })
  })
  return staged
}

function cleanupAttachments(requestId: string): void {
  try {
    rmSync(join(ATTACHMENT_DIR, requestId), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

// ── UTF-8-safe chunking of response text (§6.3, §6.6) ──────────────────

/**
 * Split `text` into substrings whose JSON-encoded response-chunk envelope
 * ({type:"response", data:<slice>}) fits within maxPayload bytes.
 *
 * Uses code-point iteration so we never split inside a UTF-16 surrogate pair.
 * We include a conservative safety margin for JSON escaping (quotes, backslashes,
 * control characters) by budgeting the `data` string at half the remaining
 * payload — worst-case JSON escaping roughly doubles length.
 */
function splitTextForChunks(text: string, maxPayload: number): string[] {
  const WRAPPER_OVERHEAD = 32      // {"type":"response","data":""} + safety
  const budget = Math.max(64, Math.floor((maxPayload - WRAPPER_OVERHEAD) / 2))
  const out: string[] = []
  let buf = ''
  let bufBytes = 0
  const encoder = new TextEncoder()

  for (const cp of text) {
    const cpBytes = encoder.encode(cp).byteLength
    if (bufBytes + cpBytes > budget && buf.length > 0) {
      out.push(buf)
      buf = ''
      bufBytes = 0
    }
    buf += cp
    bufBytes += cpBytes
  }
  if (buf.length > 0) out.push(buf)
  return out
}

// ── Safety nets ────────────────────────────────────────────────────────

process.on('unhandledRejection', err => {
  process.stderr.write(`nats channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`nats channel: uncaught exception: ${err}\n`)
})

// ── Pending requests registry ──────────────────────────────────────────

type PendingRequest = {
  replySubject: string
  createdAt: number
  ackTimer: ReturnType<typeof setInterval>
  attachmentDir?: string
}

const pendingRequests = new Map<string, PendingRequest>()
let requestCounter = 0
let lastActiveRequestId: string | undefined

function deletePending(id: string): void {
  const p = pendingRequests.get(id)
  if (!p) return
  clearInterval(p.ackTimer)
  if (p.attachmentDir) cleanupAttachments(id)
  pendingRequests.delete(id)
  if (lastActiveRequestId === id) lastActiveRequestId = undefined
}

setInterval(() => {
  const cutoff = Date.now() - REQUEST_TTL_MS
  for (const [id, req] of pendingRequests) {
    if (req.createdAt < cutoff) deletePending(id)
  }
}, 60_000).unref()

// ── Load config and connect ────────────────────────────────────────────

const config = loadConfig()
// Resolution order (uniform across agents/pi, agents/openclaw, and the
// pi-headless / claude-code-headless examples):
//   1. $NATS_CONTEXT env var
//   2. config-file `context` field (set via /nats-channel:configure)
//   3. $NATS_URL env var (raw URL; userinfo extracted via parseNatsUrl)
//   4. built-in default (demo.nats.io, no auth)
const ctxName = process.env.NATS_CONTEXT ?? config.context
const envUrl = process.env.NATS_URL
const natsCtx: NatsContext = ctxName
  ? loadNatsContext(ctxName)
  : envUrl
    ? { url: envUrl, description: 'from $NATS_URL' }
    : DEFAULT_CONTEXT
const connectOpts = contextToConnectOpts(natsCtx)

const ctxLabel = ctxName
  ? `context: ${ctxName}`
  : envUrl
    ? `$NATS_URL`
    : 'default: demo.nats.io'
process.stderr.write(`nats channel: connecting to ${natsCtx.url ?? 'default'} (${ctxLabel})\n`)
const nc = await connect(connectOpts)
// Server-negotiated max_payload (§2.1). Reflects this user/account's real
// limit, so we use it for both endpoint metadata and §5.4 enforcement.
const MAX_PAYLOAD_BYTES = nc.info?.max_payload ?? DEFAULT_MAX_PAYLOAD_BYTES
const MAX_PAYLOAD_STR = nc.info?.max_payload
  ? formatMaxPayloadString(MAX_PAYLOAD_BYTES)
  : DEFAULT_MAX_PAYLOAD_STR
process.stderr.write(`nats channel: connected (max_payload=${MAX_PAYLOAD_STR})\n`)

// ── Resolve session name and register micro service ────────────────────

const owner = sanitizeSessionName(process.env.USER ?? 'unknown') || 'unknown'
const rawSessionName = (process.env.NATS_SESSION_NAME
  ?? config.sessionName
  ?? sanitizeSessionName(basename(process.env.CLAUDE_CWD ?? '')))
  || 'default'

const sessionName = await resolveSessionName(nc, rawSessionName, owner)
// v0.3 verb-first subjects (§2): `agents.{verb}.{agent}.{owner}.{name}`.
const subject = `agents.prompt.${AGENT_SUBJECT_TOKEN}.${owner}.${sessionName}`
const heartbeatSubject = `agents.hb.${AGENT_SUBJECT_TOKEN}.${owner}.${sessionName}`
const statusSubject = `agents.status.${AGENT_SUBJECT_TOKEN}.${owner}.${sessionName}`

const svcm = new Svcm(nc)
const service = await svcm.add({
  name: SERVICE_NAME,
  version: PLUGIN_VERSION,
  description: `Claude Code — ${sessionName}`,
  metadata: {
    agent: AGENT_ID,
    owner,
    session: sessionName,
    protocol_version: PROTOCOL_VERSION,
  },
  queue: '',
})

service.addEndpoint('prompt', {
  subject,
  queue: PROMPT_QUEUE_GROUP,
  handler: (err, msg) => handleNatsMessage(err, msg),
  metadata: {
    max_payload: MAX_PAYLOAD_STR,
    attachments_ok: ATTACHMENTS_OK ? 'true' : 'false',
  },
})

const instanceId = service.info().id

// §8.7 (v0.3): status request/response endpoint replies with a freshly-built
// §8.3 heartbeat payload. Same shape as the periodic heartbeat, different
// transport (request/response instead of pub/sub).
function buildHeartbeatPayloadObject(): Record<string, unknown> {
  return {
    agent: AGENT_ID,
    owner,
    session: sessionName,
    instance_id: instanceId,
    ts: new Date().toISOString(),
    interval_s: HEARTBEAT_INTERVAL_S,
  }
}

service.addEndpoint('status', {
  subject: statusSubject,
  queue: STATUS_QUEUE_GROUP,
  handler: (err, msg: ServiceMsg) => {
    if (err) return
    try {
      msg.respond(JSON.stringify(buildHeartbeatPayloadObject()))
    } catch (e) {
      try {
        msg.respondError(500, `status handler error: ${(e as Error).message}`)
      } catch {
        // connection may already be gone
      }
    }
  },
})

process.stderr.write(`nats channel: micro service registered (id=${instanceId}) on ${subject}\n`)

// ── Heartbeat loop (§8) ────────────────────────────────────────────────

function publishHeartbeat(): void {
  nc.publish(heartbeatSubject, JSON.stringify(buildHeartbeatPayloadObject()))
}
publishHeartbeat()
const heartbeatTimer = setInterval(publishHeartbeat, HEARTBEAT_INTERVAL_S * 1000)
heartbeatTimer.unref()

// ── MCP server ─────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'nats-channel', version: PLUGIN_VERSION },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: [
      `NATS channel connected to ${natsCtx.url ?? 'default'} (${ctxLabel}), listening on ${subject}.`,
      '',
      'The sender communicates via NATS messaging, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches them.',
      '',
      'Messages from NATS arrive as <channel source="nats" request_id="..." session="..." ts="...">. If the sender included files, the channel content begins with an "[Attachments available at the following absolute paths]" block listing them — you can Read those paths to inspect the files.',
      '',
      'Reply with the reply tool — pass request_id back. Set done=false for intermediate/streaming replies; done=true (default) signals completion to the requester.',
    ].join('\n'),
  },
)

// ── Permission relay → query chunks (§7) ───────────────────────────────

const rawPermMode = config.permissions?.mode ?? 'terminal'
const permMode: PermissionMode = rawPermMode === 'nats' ? 'query' : rawPermMode

if (permMode === 'query') {
  mcp.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission_request'),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
      }),
    }),
    async ({ params }) => {
      const { request_id, tool_name, description, input_preview } = params
      const active = lastActiveRequestId
        ? pendingRequests.get(lastActiveRequestId)
        : undefined

      if (!active) {
        // No active NATS stream to emit a query on — deny by default.
        process.stderr.write(
          `nats channel: permission requested with no active NATS stream — denying (${tool_name})\n`,
        )
        void mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id, behavior: 'deny' },
        })
        return
      }

      const replyInbox = createInbox()
      const sub = nc.subscribe(replyInbox, { max: 1 })

      const promptText =
        `${tool_name}: ${description}` +
        (input_preview ? `\n\n${input_preview}` : '') +
        `\n\nReply 'yes' to allow or 'no' to deny.`

      const queryChunk = {
        type: 'query',
        data: { id: request_id, reply_subject: replyInbox, prompt: promptText },
      }
      nc.publish(active.replySubject, JSON.stringify(queryChunk))
      await nc.flush()

      const timer = setTimeout(() => sub.unsubscribe(), PERMISSION_TIMEOUT_MS)
      let behavior: 'allow' | 'deny' = 'deny'
      try {
        for await (const m of sub) {
          clearTimeout(timer)
          const raw = m.string().trim()
          behavior = interpretPermissionReply(raw)
          break
        }
      } finally {
        clearTimeout(timer)
      }

      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior },
      })
    },
  )
  process.stderr.write(`nats channel: permission relay active (query chunks)\n`)
} else {
  process.stderr.write(`nats channel: permissions handled in terminal\n`)
}

function interpretPermissionReply(raw: string): 'allow' | 'deny' {
  if (!raw) return 'deny'
  if (/^(y|yes|allow)$/i.test(raw)) return 'allow'
  if (/^(n|no|deny)$/i.test(raw)) return 'deny'
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { behavior?: string; prompt?: string }
      if (parsed.behavior === 'allow') return 'allow'
      if (parsed.behavior === 'deny') return 'deny'
      if (typeof parsed.prompt === 'string') {
        const ans = parsed.prompt.trim()
        if (/^(y|yes|allow)$/i.test(ans)) return 'allow'
        if (/^(n|no|deny)$/i.test(ans)) return 'deny'
      }
    } catch {
      /* fall through */
    }
  }
  return 'deny'
}

// ── Tools ──────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Reply over NATS. Pass request_id from the inbound <channel> message. Text is sent to the requester as a response chunk. Set done=false for intermediate/streaming replies; done=true (default) signals completion.',
      inputSchema: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: 'The request_id from the inbound <channel> message.' },
          text: { type: 'string', description: 'The reply text to send.' },
          done: {
            type: 'boolean',
            description: 'If true (default), signals completion after sending. Set false for intermediate replies.',
            default: true,
          },
        },
        required: ['request_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const requestId = args.request_id as string
        const text = args.text as string
        const done = args.done !== false

        const pending = pendingRequests.get(requestId)
        if (!pending) {
          throw new Error(`no pending request with id ${requestId} — it may have expired`)
        }

        process.stderr.write(
        const maxPayload = MAX_PAYLOAD_BYTES
        )

        const maxPayload = nc.info?.max_payload ?? DEFAULT_MAX_PAYLOAD_BYTES

        if (text.length > 0) {
          const envelope = JSON.stringify({ type: 'response', data: text })
          const envBytes = new TextEncoder().encode(envelope)
          if (envBytes.byteLength <= maxPayload) {
            nc.publish(pending.replySubject, envBytes)
          } else {
            for (const slice of splitTextForChunks(text, maxPayload)) {
              nc.publish(
                pending.replySubject,
                new TextEncoder().encode(JSON.stringify({ type: 'response', data: slice })),
              )
            }
          }
        }

        if (done) {
          // Empty-body headerless message = stream terminator (§6.5).
          nc.publish(pending.replySubject, new Uint8Array(0))
          deletePending(requestId)
        }

        await nc.flush()
        return { content: [{ type: 'text', text: 'sent' }] }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// ── Connect MCP ────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())

// ── Inbound handler ────────────────────────────────────────────────────

function handleNatsMessage(err: Error | null, msg: ServiceMsg): void {
  if (err) {
    process.stderr.write(`nats channel: handler error: ${err}\n`)
    return
  }

  const replySubject = msg.reply
  if (!replySubject) {
    process.stderr.write('nats channel: request has no reply subject — ignoring (use nats req, not nats pub)\n')
    return
  }

  const parsed = parseRequest(msg.data, MAX_PAYLOAD_BYTES)
  if (parsed.kind === 'error') {
    process.stderr.write(`nats channel: rejecting request (${parsed.code} ${parsed.description})\n`)
    msg.respondError(parsed.code, parsed.description)
    nc.publish(replySubject, new Uint8Array(0))  // §9.3: error, then terminator
    return
  }

  if (parsed.attachments.length > 0 && !ATTACHMENTS_OK) {
    msg.respondError(400, 'attachments not accepted by this endpoint')
    nc.publish(replySubject, new Uint8Array(0))
    return
  }

  const requestId = String(++requestCounter)
  const staged = stageAttachments(requestId, parsed.attachments)

  const ackTimer = setInterval(() => {
    nc.publish(replySubject, JSON.stringify({ type: 'status', data: 'ack' }))
  }, ACK_INTERVAL_MS)
  ackTimer.unref()

  pendingRequests.set(requestId, {
    replySubject,
    createdAt: Date.now(),
    ackTimer,
    attachmentDir: staged.length > 0 ? join(ATTACHMENT_DIR, requestId) : undefined,
  })
  lastActiveRequestId = requestId

  // MCP notification meta-keys become <channel> tag attributes in the model's
  // view — the harness only serializes primitive values there. Attachment
  // paths are prepended to the prompt text so the model sees them inline.
  const content = staged.length > 0
    ? `[Attachments available at the following absolute paths]\n${staged.map(s => `- ${s.path}`).join('\n')}\n\n${parsed.prompt}`
    : parsed.prompt

  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        request_id: requestId,
        session: sessionName,
        ts: new Date().toISOString(),
      },
    },
  }).catch(err => {
    process.stderr.write(`nats channel: failed to deliver inbound to Claude: ${err}\n`)
  })
}

// ── Shutdown ───────────────────────────────────────────────────────────

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('nats channel: shutting down\n')

  clearInterval(heartbeatTimer)
  for (const id of Array.from(pendingRequests.keys())) deletePending(id)

  setTimeout(() => process.exit(0), 2000)
  void service.stop()
    .then(() => nc.drain())
    .finally(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Connection status monitoring ───────────────────────────────────────

void (async () => {
  for await (const s of nc.status()) {
    switch (s.type) {
      case 'disconnect':
        process.stderr.write(`nats channel: disconnected\n`)
        break
      case 'reconnect':
        process.stderr.write(`nats channel: reconnected\n`)
        break
      case 'error':
        process.stderr.write(`nats channel: connection error: ${s.data}\n`)
        break
    }
  }
})()

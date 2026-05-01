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
import {
  AgentSubject,
  PROMPT_QUEUE_GROUP,
  ProtocolError,
  SDK_PROTOCOL_VERSION,
  SERVICE_NAME,
  STATUS_QUEUE_GROUP,
  decodeEnvelope,
  formatHumanBytes,
  parseHumanBytes,
  parseNatsUrl,
} from '@synadia-ai/agents'
import {
  DEFAULT_ATTACHMENTS_OK,
  DEFAULT_HEARTBEAT_INTERVAL_S,
  DEFAULT_MAX_PAYLOAD,
  buildHeartbeatPayload,
  encodeChunk,
  encodeHeartbeatPayload,
  splitResponseText,
} from '@synadia-ai/agent-service'
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join, basename, dirname } from 'path'
import { fileURLToPath } from 'url'

// ── Constants ──────────────────────────────────────────────────────────
const AGENT_ID = 'claude-code'          // metadata.agent (canonical per Appendix C)
const AGENT_SUBJECT_TOKEN = 'cc'        // 3rd subject token (abbreviation per Appendix C)
const ACK_INTERVAL_MS = 30_000          // keep-alive cadence; caller inactivity timeout is 60s
const PERMISSION_TIMEOUT_MS = 120_000   // query reply timeout for permission prompts
const REQUEST_TTL_MS = 30 * 60 * 1000

/** Fallback used only when `nc.info.max_payload` is unavailable. The live
 *  cap comes from the broker after connect. */
const DEFAULT_MAX_PAYLOAD_BYTES_FALLBACK = parseHumanBytes(DEFAULT_MAX_PAYLOAD)

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

// ── Attachment staging ─────────────────────────────────────────────────
// Request envelope parsing now goes through the SDK's `decodeEnvelope`
// (handles §5.1/§5.2/§5.3 + strict base64 + filename safety in one place).
// The local `{filename, bytes}` shape is kept here only because the
// staging helper writes the bytes verbatim — the adapter at the decode
// boundary is one map().

type StagedAttachment = { filename: string; path: string }

function stageAttachments(
  requestId: string,
  attachments: { filename: string; bytes: Uint8Array }[],
): StagedAttachment[] {
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
const MAX_PAYLOAD_BYTES = nc.info?.max_payload ?? DEFAULT_MAX_PAYLOAD_BYTES_FALLBACK
const MAX_PAYLOAD_STR = nc.info?.max_payload
  ? formatHumanBytes(MAX_PAYLOAD_BYTES)
  : DEFAULT_MAX_PAYLOAD
process.stderr.write(`nats channel: connected (max_payload=${MAX_PAYLOAD_STR})\n`)

// ── Resolve session name and register micro service ────────────────────

const owner = sanitizeSessionName(process.env.USER ?? 'unknown') || 'unknown'
const rawSessionName = (process.env.NATS_SESSION_NAME
  ?? config.sessionName
  ?? sanitizeSessionName(basename(process.env.CLAUDE_CWD ?? '')))
  || 'default'

const sessionName = await resolveSessionName(nc, rawSessionName, owner)
// `metadata.agent` carries the canonical "claude-code"; the wire subject's
// 3rd token is the conventional abbreviation `cc` (Appendix C).
// `AgentSubject.new(...)`'s `subjectToken` option owns this split.
const agentSubject = AgentSubject.new(AGENT_ID, owner, sessionName, {
  subjectToken: AGENT_SUBJECT_TOKEN,
})
const subject = agentSubject.prompt
const heartbeatSubject = agentSubject.heartbeat
const statusSubject = agentSubject.status

const svcm = new Svcm(nc)
const service = await svcm.add({
  name: SERVICE_NAME,
  version: PLUGIN_VERSION,
  description: `Claude Code — ${sessionName}`,
  metadata: {
    agent: AGENT_ID,
    owner,
    session: sessionName,
    protocol_version: `${SDK_PROTOCOL_VERSION.major}.${SDK_PROTOCOL_VERSION.minor}`,
  },
  queue: '',
})

service.addEndpoint('prompt', {
  subject,
  queue: PROMPT_QUEUE_GROUP,
  handler: (err, msg) => handleNatsMessage(err, msg),
  metadata: {
    max_payload: MAX_PAYLOAD_STR,
    attachments_ok: DEFAULT_ATTACHMENTS_OK ? 'true' : 'false',
  },
})

const instanceId = service.info().id

// §8.7 (v0.3): status request/response endpoint replies with a freshly-built
// §8.3 heartbeat payload. Same shape as the periodic heartbeat, different
// transport (request/response instead of pub/sub).
function buildHeartbeatBytes(): Uint8Array {
  return encodeHeartbeatPayload(
    buildHeartbeatPayload(agentSubject, DEFAULT_HEARTBEAT_INTERVAL_S, instanceId, {
      session: sessionName,
    }),
  )
}

service.addEndpoint('status', {
  subject: statusSubject,
  queue: STATUS_QUEUE_GROUP,
  handler: (err, msg: ServiceMsg) => {
    if (err) return
    try {
      msg.respond(buildHeartbeatBytes())
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
  nc.publish(heartbeatSubject, buildHeartbeatBytes())
}
publishHeartbeat()
const heartbeatTimer = setInterval(publishHeartbeat, DEFAULT_HEARTBEAT_INTERVAL_S * 1000)
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
          `nats channel: replying to ${pending.replySubject} (request ${requestId}, done=${done}, bytes=${text.length})\n`,
        )

        if (text.length > 0) {
          const envBytes = encodeChunk({ type: 'response', text })
          if (envBytes.byteLength <= MAX_PAYLOAD_BYTES) {
            nc.publish(pending.replySubject, envBytes)
          } else {
            for (const slice of splitResponseText(text, MAX_PAYLOAD_BYTES)) {
              nc.publish(pending.replySubject, encodeChunk({ type: 'response', text: slice }))
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

  // §5.4: enforce max_payload locally before envelope decode so we surface
  // the dedicated "exceeds max_payload" error rather than a generic
  // ProtocolError from the SDK decoder.
  if (msg.data.byteLength > MAX_PAYLOAD_BYTES) {
    msg.respondError(400, 'request exceeds max_payload')
    nc.publish(replySubject, new Uint8Array(0))
    return
  }

  // SDK's `decodeEnvelope` covers §5.1/§5.2/§5.3 plus strict base64 +
  // filename safety in one place. Throws `ProtocolError` on violation; we
  // map that to 400 (the previous `parseRequest` only ever produced 400s).
  let envelope: ReturnType<typeof decodeEnvelope>
  try {
    envelope = decodeEnvelope(msg.data)
  } catch (e) {
    const code = e instanceof ProtocolError ? 400 : 500
    const description = (e as Error).message
    process.stderr.write(`nats channel: rejecting request (${code} ${description})\n`)
    msg.respondError(code, description)
    nc.publish(replySubject, new Uint8Array(0))  // §9.3: error, then terminator
    return
  }

  const sdkAttachments = envelope.attachments ?? []
  if (sdkAttachments.length > 0 && !DEFAULT_ATTACHMENTS_OK) {
    msg.respondError(400, 'attachments not accepted by this endpoint')
    nc.publish(replySubject, new Uint8Array(0))
    return
  }

  const requestId = String(++requestCounter)
  // SDK delivers attachments as `{filename, content: Uint8Array}`; the
  // staging helper writes bytes verbatim under the legacy `bytes` key.
  const staged = stageAttachments(
    requestId,
    sdkAttachments.map((a) => ({ filename: a.filename, bytes: a.content })),
  )

  const ackTimer = setInterval(() => {
    nc.publish(replySubject, encodeChunk({ type: 'status', status: 'ack' }))
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
    ? `[Attachments available at the following absolute paths]\n${staged.map(s => `- ${s.path}`).join('\n')}\n\n${envelope.prompt}`
    : envelope.prompt

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

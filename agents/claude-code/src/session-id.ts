import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * What the plugin's hooks record for the server, and how the server reads it.
 *
 * The MCP server is a child of the Claude Code process and outlives
 * `/clear`, which starts a new session under it; it sees neither the
 * session id Claude Code is using now, nor the start or end of a turn,
 * nor the model's id for a tool call. The plugin's hooks
 * (`hooks/hooks.json`, `hooks/session-event.ts`) see them and write them under
 * `<state dir>/sessions/`, keyed by the Claude Code process id, which
 * Claude Code hands its hooks and its MCP servers alike as `CLAUDE_PID`:
 *
 *   - `<pid>`         SessionStart: `{ session_id, source, at_ms }`
 *   - `<pid>.stop`    Stop: `{ session_id, background, final_text, at_ms }`,
 *                     the turn's end, whether background work could start
 *                     another, and the turn's final text when a served prompt
 *                     may still be waiting for it
 *   - `<pid>.nudge`   a Stop the hook refused: `{ final_text, at_ms }`, the
 *                     text the model wrote before it was told to reply. Not
 *                     a stop; the next recorded Stop takes it and removes it
 *   - `<pid>.turn`    PreToolUse, every tool call: `{ prompt_id, first_ms,
 *                     at_ms }`, the turn the latest call belongs to and when
 *                     that turn's first call was made
 *   - `<pid>.tools/`  PreToolUse, one file per agent-tool call:
 *                     `{ tool_use_id, tool_name, tool_input, prompt_id,
 *                     at_ms }`
 *   - `<pid>.events`  an append-only log, one JSON line per event:
 *                     UserPromptSubmit `{ event: "submit", session_id,
 *                     prompt_id, request_id?, source?, at_ms }` (`request_id`
 *                     and `source` for this channel's own messages only,
 *                     never the prompt's text); a recorded Stop `{ event:
 *                     "stop", session_id, prompt_id, background?,
 *                     final_text?, at_ms }`, the same as `<pid>.stop`; and
 *                     StopFailure `{ event: "failure", session_id, prompt_id,
 *                     error, error_details?, at_ms }`, a turn ended by an
 *                     API error: its type (`billing_error`, `rate_limit`, …)
 *                     and its details cut to 200 characters, never the
 *                     turn's text
 *
 * `.stop` and `.turn` hold one record each: the latest. Claude Code's hooks
 * run faster than the server polls (a short turn's submit and Stop are tens
 * of milliseconds apart, and two Stops can follow each other as closely),
 * so the server follows turns by `.events`, which loses none of them. About
 * two lines and 300 bytes per turn; it is never rotated, since the server
 * reads it from where it left off, and a whole read stays in milliseconds
 * for a session of thousands of turns.
 *
 * One file goes the other way, written by the server for the Stop hook:
 *
 *   - `<pid>.open`    `{ server_pid, request_ids, open_ids, since_ms,
 *                     at_ms }`: `request_ids` the open served prompts the
 *                     server's ledger says own the running turn, `open_ids`
 *                     every open served prompt the server has delivered,
 *                     `since_ms` when the server started. At a Stop that
 *                     would end one of the prompts waiting for that turn,
 *                     the hook refuses the stop once and tells the model to
 *                     reply. Which prompts wait for a turn, the hook works
 *                     out by itself, never waiting for the server: a short
 *                     turn's Stop comes before the server's next poll. For
 *                     a Stop with a prompt id P, once the log holds a
 *                     submit with a prompt id, they are the `open_ids` whose
 *                     latest submit in the log since `since_ms` carried P:
 *                     the UserPromptSubmit hook wrote it before that turn
 *                     ran. Otherwise `request_ids`.
 *
 * Every file but `.events` is written atomically (a rename), so a reader
 * sees a whole record or the previous one; `.events` is appended to, and a
 * reader takes whole lines only. The hooks write whether or not an
 * extension is loaded; nothing here depends on one.
 */

// Header-safe by construction: an extension may put the id in a header or
// a JSON field another system matches against, so anything a header value
// could never hold — empty, whitespace, control characters — is refused
// rather than recorded. Claude Code's ids are UUIDs.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
// Claude Code's tool-use ids (`toolu_…`); also a file name, so no separators.
const TOOL_USE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/**
 * The agent tools, whose PreToolUse ids the server hands on. Kept here, not
 * imported, so the hook depends on nothing outside the plugin directory.
 */
const AGENT_TOOL_NAMES = [
  'discover_agents',
  'prompt_agent',
  'wait_agent',
  'answer_agent',
  'cancel_agent',
  'list_agent_calls',
] as const

/** How long a PreToolUse record waits for its tool call before it is dropped. */
export const TOOL_USE_MAX_AGE_MS = 60_000

/** `true` iff `value` is shaped like a session id Claude Code would send. */
export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

/** `true` iff `value` is shaped like a tool-use id, usable as a file name. */
export function isToolUseId(value: unknown): value is string {
  return typeof value === 'string' && TOOL_USE_ID_RE.test(value)
}

/** Directory of the per-Claude-process files under the state dir. */
export function sessionsDir(stateDir: string): string {
  return join(stateDir, 'sessions')
}

/** The file the SessionStart hook writes for Claude Code process `pid`. */
export function sessionFilePath(stateDir: string, pid: number | string): string {
  return join(sessionsDir(stateDir), String(pid))
}

/** The file the Stop hook writes for Claude Code process `pid` when a turn ends. */
export function stopFilePath(stateDir: string, pid: number | string): string {
  return join(sessionsDir(stateDir), `${pid}.stop`)
}

/** The file the Stop hook writes when it refuses a stop: that stop's final text. */
export function nudgeFilePath(stateDir: string, pid: number | string): string {
  return join(sessionsDir(stateDir), `${pid}.nudge`)
}

/** The file the PreToolUse hook writes on every tool call: the current turn. */
export function turnFilePath(stateDir: string, pid: number | string): string {
  return join(sessionsDir(stateDir), `${pid}.turn`)
}

/** The file the server writes for the Stop hook: the open prompts that own the turn. */
export function openFilePath(stateDir: string, pid: number | string): string {
  return join(sessionsDir(stateDir), `${pid}.open`)
}

/** The directory the PreToolUse hook writes one file per tool call into. */
export function toolUsesDir(stateDir: string, pid: number | string): string {
  return join(sessionsDir(stateDir), `${pid}.tools`)
}

/** The log the hooks append a line to per submitted prompt, recorded Stop and StopFailure. */
export function eventsFilePath(stateDir: string, pid: number | string): string {
  return join(sessionsDir(stateDir), `${pid}.events`)
}

export type SessionIdSource = {
  /** The MCP server's environment. */
  env: NodeJS.ProcessEnv
  /** The channel's state directory (`NATS_STATE_DIR`). */
  stateDir: string
  /** The Claude Code process that launched the server; see {@link claudePid}. */
  parentPid: number
}

/**
 * The Claude Code process the hooks key their files by: `CLAUDE_PID` from
 * the environment, which Claude Code hands to its hooks and MCP servers
 * alike, or the parent pid when it is absent.
 */
export function claudePid(env: NodeJS.ProcessEnv, parentPid: number): number {
  const fromEnv = env.CLAUDE_PID
  return fromEnv !== undefined && /^\d+$/.test(fromEnv) ? Number(fromEnv) : parentPid
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing: what the hook script does with its input
// ─────────────────────────────────────────────────────────────────────────────

/** Write `content` to `target` through a rename, so a reader never sees half of it. */
export function writeAtomically(target: string, content: string): void {
  const staging = `${target}.${process.pid}.tmp`
  writeFileSync(staging, content)
  renameSync(staging, target)
}

// Claude Code names an MCP tool `mcp__<server>__<tool>`; the anchor is the
// one the hook's matcher used when it ran for the agent tools only.
const AGENT_TOOL_NAME_RE = new RegExp(`^mcp__.+__(${AGENT_TOOL_NAMES.join('|')})$`)

/** `true` iff `name` is one of the agent tools as Claude Code names an MCP tool. */
export function isAgentToolName(name: string): boolean {
  return AGENT_TOOL_NAME_RE.test(name)
}

/**
 * Whether the Stop hook's input says background work could start another
 * turn by itself: background tasks still running, or crons scheduled in the
 * session. `undefined` when the input carries neither field (a Claude Code
 * that does not report them), which the server reads as "could".
 */
function backgroundWork(input: Readonly<Record<string, unknown>>): boolean | undefined {
  if (!('background_tasks' in input) && !('session_crons' in input)) return undefined
  return nonEmpty(input.background_tasks) || nonEmpty(input.session_crons)
}

function nonEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '') {
    return false
  }
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

// This plugin's MCP server is `nats` in its `.mcp.json`, so Claude Code tags
// its channel messages `<channel source="plugin:<plugin>:nats" …>`. Another
// channel plugin's `request_id="1"` has another source and is never ours.
const CHANNEL_SOURCE_RE = /^plugin:[^"]+:nats$/
// The request ids the server hands out; the same rule as the server's file.
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// How far into a prompt the opening tag is looked for.
const CHANNEL_TAG_MAX = 1024
// A StopFailure's error type and details, as long as they are kept.
const FAILURE_ERROR_MAX = 64
export const FAILURE_DETAILS_MAX = 200

/**
 * The request a submitted prompt carries when it is this channel's message:
 * the `request_id` and `source` of the `<channel …>` tag it begins with, or
 * `undefined` for anything else (typed text, a command, another channel's
 * message, a tag without both attributes). Only the tag is read.
 */
export function channelPrompt(prompt: unknown): { requestId: string; source: string } | undefined {
  if (typeof prompt !== 'string' || !prompt.startsWith('<channel ')) return undefined
  const end = prompt.indexOf('>')
  if (end < 0 || end > CHANNEL_TAG_MAX) return undefined
  const tag = prompt.slice(0, end)
  const source = /\ssource="([^"]*)"/.exec(tag)?.[1]
  const requestId = /\srequest_id="([^"]*)"/.exec(tag)?.[1]
  if (source === undefined || requestId === undefined) return undefined
  if (!CHANNEL_SOURCE_RE.test(source) || !REQUEST_ID_RE.test(requestId)) return undefined
  return { requestId, source }
}

/**
 * A StopFailure field as kept: one line, no control characters, at most
 * `max` characters; `undefined` for anything that is not a non-empty string.
 */
function failureText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = Array.from(value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, max).join('')
  return text.length > 0 ? text : undefined
}

/** Append one line to the events log; never through a rename, so no line is lost. */
function appendEvent(stateDir: string, pid: number | string, line: Readonly<Record<string, unknown>>): void {
  mkdirSync(sessionsDir(stateDir), { recursive: true })
  appendFileSync(eventsFilePath(stateDir, pid), `${JSON.stringify(line)}\n`)
}

/**
 * Record one hook event for Claude Code process `pid`, from the hook's
 * input as Claude Code gave it. Returns what was written, or `undefined`
 * for an event this plugin does not record or a malformed input:
 * `'tool'` for an agent-tool call (its id file and the turn file),
 * `'turn'` for any other tool call (the turn file only), `'submit'` and
 * `'failure'` for a line in the events log.
 * `now` is the hook's clock, epoch milliseconds.
 */
export function recordHookEvent(
  stateDir: string,
  pid: number | string,
  input: Readonly<Record<string, unknown>>,
  now: number = Date.now(),
): 'session' | 'stop' | 'tool' | 'turn' | 'submit' | 'failure' | undefined {
  const event = input.hook_event_name
  const sessionId = isClaudeSessionId(input.session_id) ? input.session_id : undefined
  const promptId = isClaudeSessionId(input.prompt_id) ? input.prompt_id : undefined
  if (event === 'UserPromptSubmit') {
    // The ids only: never the prompt's text.
    const channel = channelPrompt(input.prompt)
    appendEvent(stateDir, pid, {
      event: 'submit',
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(promptId ? { prompt_id: promptId } : {}),
      ...(channel ? { request_id: channel.requestId, source: channel.source } : {}),
      at_ms: now,
    })
    return 'submit'
  }
  if (event === 'StopFailure') {
    // The error's type and details; never the turn's text
    // (`last_assistant_message`).
    const error = failureText(input.error, FAILURE_ERROR_MAX)
    const details = failureText(input.error_details, FAILURE_DETAILS_MAX)
    appendEvent(stateDir, pid, {
      event: 'failure',
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(promptId ? { prompt_id: promptId } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(details !== undefined ? { error_details: details } : {}),
      at_ms: now,
    })
    return 'failure'
  }
  if (event === 'SessionStart') {
    if (sessionId === undefined) return undefined
    const source = typeof input.source === 'string' ? input.source : 'unknown'
    mkdirSync(sessionsDir(stateDir), { recursive: true })
    writeAtomically(
      sessionFilePath(stateDir, pid),
      `${JSON.stringify({ session_id: sessionId, source, at_ms: now })}\n`,
    )
    return 'session'
  }
  if (event === 'Stop') {
    const background = backgroundWork(input)
    // The final text is kept only when a served prompt may still be waiting
    // for it: one waits for this turn, or the server's file cannot be read.
    // The text of a stop the hook refused in this turn comes first: a model
    // writes its answer before it is told to reply, and what it writes after
    // that is a reaction to being told.
    const waiting = waitingRequests(stateDir, pid, input)
    const text =
      waiting === undefined || waiting.length > 0
        ? (refusedStopText(stateDir, pid) ?? finalText(input))
        : undefined
    const record = {
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(background !== undefined ? { background } : {}),
      ...(text !== undefined ? { final_text: text } : {}),
      at_ms: now,
    }
    mkdirSync(sessionsDir(stateDir), { recursive: true })
    writeAtomically(stopFilePath(stateDir, pid), `${JSON.stringify(record)}\n`)
    // The same Stop, whole, in the log: `.stop` keeps only the latest, and
    // the next turn's Stop can follow within one of the server's polls.
    appendEvent(stateDir, pid, { event: 'stop', ...(promptId ? { prompt_id: promptId } : {}), ...record })
    removeQuietly(nudgeFilePath(stateDir, pid))
    return 'stop'
  }
  if (event === 'PreToolUse') {
    const id = input.tool_use_id
    const name = input.tool_name
    if (typeof name !== 'string' || name.length === 0) return undefined
    mkdirSync(sessionsDir(stateDir), { recursive: true })
    recordTurnActivity(stateDir, pid, input.prompt_id, now)
    if (!isAgentToolName(name) || !isToolUseId(id)) return 'turn'
    const dir = toolUsesDir(stateDir, pid)
    mkdirSync(dir, { recursive: true })
    writeAtomically(
      join(dir, id),
      `${JSON.stringify({
        tool_use_id: id,
        tool_name: name,
        tool_input: input.tool_input ?? null,
        ...(promptId ? { prompt_id: promptId } : {}),
        at_ms: now,
      })}\n`,
    )
    return 'tool'
  }
  return undefined
}

/**
 * The turn file on a tool call: the call's prompt id, and the time of the
 * turn's first call — kept from the previous record when that one is of the
 * same prompt and newer than the last Stop, else now.
 */
function recordTurnActivity(
  stateDir: string,
  pid: number | string,
  promptId: unknown,
  now: number,
): void {
  const id = isClaudeSessionId(promptId) ? promptId : undefined
  const previous = readJson(turnFilePath(stateDir, pid))
  const previousAt = epochMs(previous?.at_ms)
  const previousFirst = epochMs(previous?.first_ms)
  const stopAt = epochMs(readJson(stopFilePath(stateDir, pid))?.at_ms)
  const sameTurn =
    previous !== undefined &&
    previous.prompt_id === id &&
    previousAt !== undefined &&
    previousFirst !== undefined &&
    (stopAt === undefined || previousAt > stopAt)
  writeAtomically(
    turnFilePath(stateDir, pid),
    `${JSON.stringify({
      ...(id !== undefined ? { prompt_id: id } : {}),
      first_ms: sameTurn ? previousFirst : now,
      at_ms: now,
    })}\n`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The turn's end: the nudge and the final text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Stop hook's answer to a stop that would end a served prompt without
 * its reply: the reason to give the model when the stop is refused, or
 * `undefined` to let the turn end. It refuses only when all of these hold:
 *
 *   - Claude Code is not already continuing after a refused stop
 *     (`stop_hook_active`), so the model is told once per turn;
 *   - the stop says no background work is left, the only stop at which the
 *     server ends the prompts waiting for the turn;
 *   - open prompts wait for this turn ({@link waitingRequests}), and the
 *     server that wrote its file is still running.
 *
 * Anything it cannot tell lets the turn end (fail open): no file, a
 * malformed one, a server gone.
 */
export function stopRefusal(
  stateDir: string,
  pid: number | string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  if (input.hook_event_name !== 'Stop' || input.stop_hook_active === true) return undefined
  if (backgroundWork(input) !== false) return undefined
  const open = waitingRequests(stateDir, pid, input)
  if (open === undefined || open.length === 0) return undefined
  const ids = open.map(id => `"${id}"`).join(', ')
  return (
    `The NATS channel ${open.length === 1 ? 'request' : 'requests'} ${ids} ` +
    `${open.length === 1 ? 'is' : 'are'} still open: the sender has not received an answer, ` +
    'and cannot see this session\'s own output. Send your answer with the reply tool ' +
    '(load it with ToolSearch if it is deferred), with the request_id and done: true.'
  )
}

/**
 * Keep the final text of a stop the hook refuses, for the stop that follows
 * in the same turn. Not a stop: the Stop file is not touched, so the server
 * counts nothing. Written even without text, so a refused stop with none
 * does not leave an older one's to be taken.
 */
export function recordRefusedStop(
  stateDir: string,
  pid: number | string,
  input: Readonly<Record<string, unknown>>,
  now: number = Date.now(),
): void {
  const text = finalText(input)
  mkdirSync(sessionsDir(stateDir), { recursive: true })
  writeAtomically(
    nudgeFilePath(stateDir, pid),
    `${JSON.stringify({ ...(text !== undefined ? { final_text: text } : {}), at_ms: now })}\n`,
  )
}

/**
 * The text a refused stop kept, when the refusal came after the last
 * recorded Stop (this turn's), else `undefined`.
 */
function refusedStopText(stateDir: string, pid: number | string): string | undefined {
  const nudge = readJson(nudgeFilePath(stateDir, pid))
  const at = epochMs(nudge?.at_ms)
  if (nudge === undefined || at === undefined) return undefined
  const lastStop = epochMs(readJson(stopFilePath(stateDir, pid))?.at_ms)
  if (lastStop !== undefined && at <= lastStop) return undefined
  const text = nudge.final_text
  return typeof text === 'string' && text.length > 0 ? text : undefined
}

/**
 * Write the open prompts for the Stop hook: `requestIds` those the ledger
 * says own the running turn, `open.openIds` every open prompt delivered
 * (`requestIds` when not given), `open.sinceMs` when the server started.
 * The server calls this whenever the sets change, and with none at start.
 */
export function writeOpenRequests(
  stateDir: string,
  pid: number | string,
  requestIds: readonly string[],
  serverPid: number = process.pid,
  now: number = Date.now(),
  open: { readonly openIds?: readonly string[]; readonly sinceMs?: number } = {},
): void {
  mkdirSync(sessionsDir(stateDir), { recursive: true })
  writeAtomically(
    openFilePath(stateDir, pid),
    `${JSON.stringify({
      server_pid: serverPid,
      request_ids: requestIds,
      open_ids: open.openIds ?? requestIds,
      ...(open.sinceMs !== undefined ? { since_ms: open.sinceMs } : {}),
      at_ms: now,
    })}\n`,
  )
}

/** The server's file for the Stop hook, as read. */
export type OpenRequests = {
  /** The open prompts the server's ledger says own the running turn. */
  readonly requestIds: string[]
  /** Every open prompt the server has delivered. */
  readonly openIds: string[]
  /** When the server started: request ids restart with each server. */
  readonly sinceMs?: number
}

/** Remove the server's file, at shutdown. Best effort. */
export function clearOpenRequests(stateDir: string, pid: number | string): void {
  removeQuietly(openFilePath(stateDir, pid))
}

/**
 * The open prompts the server's file says own the running turn, or
 * `undefined` when it cannot be told: no file, a malformed one, or a
 * server no longer running.
 */
export function readOpenRequests(stateDir: string, pid: number | string): string[] | undefined {
  return readOpenFile(stateDir, pid)?.requestIds
}

/** The server's whole file, or `undefined` as {@link readOpenRequests}. */
export function readOpenFile(stateDir: string, pid: number | string): OpenRequests | undefined {
  const value = readJson(openFilePath(stateDir, pid))
  if (!value) return undefined
  const serverPid = value.server_pid
  const ids = requestIdList(value.request_ids)
  const openIds = value.open_ids === undefined ? ids : requestIdList(value.open_ids)
  if (typeof serverPid !== 'number' || !Number.isSafeInteger(serverPid) || serverPid <= 0) {
    return undefined
  }
  if (ids === undefined || openIds === undefined) return undefined
  if (!processAlive(serverPid)) return undefined
  const sinceMs = epochMs(value.since_ms)
  return { requestIds: ids, openIds, ...(sinceMs !== undefined ? { sinceMs } : {}) }
}

function requestIdList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(id => typeof id === 'string' && REQUEST_ID_RE.test(id))
    ? (value as string[])
    : undefined
}

/**
 * The open prompts the turn a Stop ends leaves without their reply, for the
 * Stop hook, or `undefined` when the server's file cannot be read (fail
 * safe: the final text is kept, the stop not refused).
 *
 * Once the log holds a submit with a prompt id, and the Stop carries its
 * turn's prompt id P: the delivered prompts still open whose latest submit
 * since the server started carried P — the turn they began, or the one
 * they were folded into. A prompt not yet taken into a turn waits for none.
 * Otherwise, the prompts the server's ledger says own the turn.
 */
export function waitingRequests(
  stateDir: string,
  pid: number | string,
  input: Readonly<Record<string, unknown>>,
): string[] | undefined {
  const open = readOpenFile(stateDir, pid)
  if (open === undefined) return undefined
  const promptId = isClaudeSessionId(input.prompt_id) ? input.prompt_id : undefined
  if (promptId === undefined) return open.requestIds
  const events = readEvents(stateDir, pid)
  if (!events.some(event => event.kind === 'submit' && event.submit.promptId !== undefined)) {
    return open.requestIds
  }
  // Request ids restart with each server: the latest submit of each wins.
  const takenIn = new Map<string, string | undefined>()
  for (const event of events) {
    if (event.kind !== 'submit' || event.submit.requestId === undefined) continue
    if (open.sinceMs !== undefined && event.submit.atMs < open.sinceMs) continue
    takenIn.set(event.submit.requestId, event.submit.promptId)
  }
  return open.openIds.filter(id => takenIn.get(id) === promptId)
}

/**
 * The text of the turn's last assistant message, trimmed, or `undefined`
 * when it has none. Claude Code hands it to the Stop hook as
 * `last_assistant_message`; a Claude Code that does not is read from the
 * session's transcript (`transcript_path`, one JSON entry per line), where
 * the last assistant message may span several entries with one message id.
 */
export function finalText(input: Readonly<Record<string, unknown>>): string | undefined {
  if ('last_assistant_message' in input) {
    const given = input.last_assistant_message
    return typeof given === 'string' && given.trim().length > 0 ? given.trim() : undefined
  }
  const path = input.transcript_path
  if (typeof path !== 'string' || path.length === 0) return undefined
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let lastId: unknown
  let parts: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const { type, message, uuid } = entry as Record<string, unknown>
    if (type !== 'assistant' || typeof message !== 'object' || message === null) continue
    const { id, content } = message as Record<string, unknown>
    const messageId = id ?? uuid
    if (messageId === undefined || messageId !== lastId) {
      lastId = messageId
      parts = []
    }
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown> | null
        if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
    }
  }
  const joined = parts.join('\n').trim()
  return joined.length > 0 ? joined : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading: what the server makes of the files
// ─────────────────────────────────────────────────────────────────────────────

/** The session the SessionStart hook recorded last. */
export type SessionRecord = {
  readonly sessionId: string
  readonly source: string
  readonly atMs: number
}

/** A turn end the Stop hook recorded: the latest in `.stop`, each one in `.events`. */
export type StopRecord = {
  readonly sessionId?: string
  /** Claude Code's id for the turn's prompt, when it gave one. */
  readonly promptId?: string
  /** Background work could start another turn; absent when Claude Code did not say. */
  readonly background?: boolean
  /** The turn's final text, kept when a served prompt may still be waiting for it. */
  readonly finalText?: string
  readonly atMs: number
}

/** A prompt Claude Code took into a turn, as the UserPromptSubmit hook recorded it. */
export type SubmitRecord = {
  readonly sessionId?: string
  /** Claude Code's id for the turn the prompt runs in. */
  readonly promptId?: string
  /** This channel's request, when the prompt was its message. */
  readonly requestId?: string
  /** The channel tag's `source`, with `requestId`. */
  readonly source?: string
  readonly atMs: number
}

/** A turn an API error ended, as the StopFailure hook recorded it. */
export type FailureRecord = {
  readonly sessionId?: string
  readonly promptId?: string
  /** The API error's type, as Claude Code named it: `billing_error`, `rate_limit`, … */
  readonly error?: string
  /** Its details, cut to {@link FAILURE_DETAILS_MAX} characters. */
  readonly errorDetails?: string
  readonly atMs: number
}

/** One line of the events log. */
export type SessionEvent =
  | { readonly kind: 'submit'; readonly submit: SubmitRecord }
  | { readonly kind: 'stop'; readonly stop: StopRecord }
  | { readonly kind: 'failure'; readonly failure: FailureRecord }

/** The latest tool call the PreToolUse hook recorded: the turn it belongs to. */
export type TurnActivity = {
  /** Claude Code's id for the prompt the call serves, when it gave one. */
  readonly promptId?: string
  /** When the turn's first tool call was recorded. */
  readonly firstMs: number
  /** When the latest tool call was recorded. */
  readonly atMs: number
}

function readJson(path: string): Record<string, unknown> | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function epochMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

/** The SessionStart record for the Claude Code process, or `undefined` without a well-formed file. */
export function readSessionRecord(source: SessionIdSource): SessionRecord | undefined {
  const value = readJson(sessionFilePath(source.stateDir, source.parentPid))
  if (!value || !isClaudeSessionId(value.session_id)) return undefined
  const atMs = epochMs(value.at_ms)
  if (atMs === undefined) return undefined
  return {
    sessionId: value.session_id,
    source: typeof value.source === 'string' ? value.source : 'unknown',
    atMs,
  }
}

/** The last Stop record for the Claude Code process, or `undefined` without a well-formed file. */
export function readTurnStop(source: SessionIdSource): StopRecord | undefined {
  return stopRecordOf(readJson(stopFilePath(source.stateDir, source.parentPid)))
}

function stopRecordOf(value: Record<string, unknown> | undefined): StopRecord | undefined {
  if (!value) return undefined
  const atMs = epochMs(value.at_ms)
  if (atMs === undefined) return undefined
  return {
    ...(isClaudeSessionId(value.session_id) ? { sessionId: value.session_id } : {}),
    ...(isClaudeSessionId(value.prompt_id) ? { promptId: value.prompt_id } : {}),
    ...(typeof value.background === 'boolean' ? { background: value.background } : {}),
    ...(typeof value.final_text === 'string' && value.final_text.length > 0
      ? { finalText: value.final_text }
      : {}),
    atMs,
  }
}

/** One line of the events log, or `undefined` for a malformed one or another event. */
export function parseEventLine(line: string): SessionEvent | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const atMs = epochMs(record.at_ms)
  if (atMs === undefined) return undefined
  const ids = {
    ...(isClaudeSessionId(record.session_id) ? { sessionId: record.session_id } : {}),
    ...(isClaudeSessionId(record.prompt_id) ? { promptId: record.prompt_id } : {}),
  }
  switch (record.event) {
    case 'submit': {
      const channel =
        typeof record.request_id === 'string' &&
        REQUEST_ID_RE.test(record.request_id) &&
        typeof record.source === 'string' &&
        CHANNEL_SOURCE_RE.test(record.source)
          ? { requestId: record.request_id, source: record.source }
          : {}
      return { kind: 'submit', submit: { ...ids, ...channel, atMs } }
    }
    case 'stop': {
      const stop = stopRecordOf(record)
      return stop ? { kind: 'stop', stop } : undefined
    }
    case 'failure': {
      const error = failureText(record.error, FAILURE_ERROR_MAX)
      const details = failureText(record.error_details, FAILURE_DETAILS_MAX)
      return {
        kind: 'failure',
        failure: {
          ...ids,
          ...(error !== undefined ? { error } : {}),
          ...(details !== undefined ? { errorDetails: details } : {}),
          atMs,
        },
      }
    }
    default:
      return undefined
  }
}

/**
 * `true` iff the events log holds a submit with a prompt id: this Claude
 * Code reports which turn takes each prompt, and the channel follows its
 * turns by their ids (`src/turns.ts`).
 */
export function promptIdsReported(stateDir: string, pid: number | string): boolean {
  return readEvents(stateDir, pid).some(
    (event) => event.kind === 'submit' && event.submit.promptId !== undefined,
  )
}

/** Every well-formed line of the events log, in the order written; none without a file. */
export function readEvents(stateDir: string, pid: number | string): SessionEvent[] {
  let text: string
  try {
    text = readFileSync(eventsFilePath(stateDir, pid), 'utf8')
  } catch {
    return []
  }
  const events: SessionEvent[] = []
  // A last line without its newline is still being written.
  const end = text.lastIndexOf('\n')
  for (const line of text.slice(0, end + 1).split('\n')) {
    if (line.length === 0) continue
    const event = parseEventLine(line)
    if (event) events.push(event)
  }
  return events
}

/** The latest tool call's turn record, or `undefined` without a well-formed file. */
export function readTurnActivity(source: SessionIdSource): TurnActivity | undefined {
  const value = readJson(turnFilePath(source.stateDir, source.parentPid))
  if (!value) return undefined
  const atMs = epochMs(value.at_ms)
  const firstMs = epochMs(value.first_ms)
  if (atMs === undefined || firstMs === undefined) return undefined
  return {
    ...(isClaudeSessionId(value.prompt_id) ? { promptId: value.prompt_id } : {}),
    firstMs,
    atMs,
  }
}

/**
 * The current session id, or `undefined` when neither the hook file nor
 * the environment names one. The file wins when present and well-formed:
 * it is newer than the environment by construction (`/clear`).
 */
export function resolveClaudeSessionId(source: SessionIdSource): string | undefined {
  const fromHook = readSessionRecord(source)
  if (fromHook !== undefined) return fromHook.sessionId
  const fromEnv = source.env.CLAUDE_CODE_SESSION_ID
  return isClaudeSessionId(fromEnv) ? fromEnv : undefined
}

/**
 * `true` iff the plugin's hooks are active for this Claude Code process —
 * the SessionStart hook has written its file — so a Stop can be expected
 * at the end of a turn.
 */
export function hooksActive(source: SessionIdSource): boolean {
  return existsSync(sessionFilePath(source.stateDir, source.parentPid))
}

/**
 * The model's id for the tool call now reaching the server, from the
 * PreToolUse record the hook wrote for it, and the record removed. Claude
 * Code runs the hook to completion before it sends the MCP call, so the
 * record is there when the call arrives.
 *
 * A record matches when its `tool_name` is `toolName` or ends in
 * `__<toolName>` (Claude Code names an MCP tool `mcp__<server>__<tool>`).
 * Among those, one whose `tool_input` equals `args` wins, so parallel
 * calls of the same tool each get their own id; otherwise the oldest.
 * Records older than {@link TOOL_USE_MAX_AGE_MS} belong to calls that
 * never reached this server and are removed on the way. Best effort:
 * `undefined` when nothing matches. With the id comes the call's prompt id,
 * the turn that made it, when Claude Code gave one.
 */
export function takeToolUse(
  source: SessionIdSource,
  toolName: string,
  args: unknown,
  now: number = Date.now(),
): ToolUse | undefined {
  const dir = toolUsesDir(source.stateDir, source.parentPid)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  const wanted = canonicalJson(args ?? {})
  type Candidate = { id: string; atMs: number; promptId?: string }
  let exact: Candidate | undefined
  let oldest: Candidate | undefined
  for (const name of names) {
    if (!isToolUseId(name)) continue
    const path = join(dir, name)
    const record = readJson(path)
    const atMs = epochMs(record?.at_ms)
    if (!record || atMs === undefined || now - atMs > TOOL_USE_MAX_AGE_MS) {
      removeQuietly(path)
      continue
    }
    const recorded = record.tool_name
    if (
      record.tool_use_id !== name ||
      typeof recorded !== 'string' ||
      (recorded !== toolName && !recorded.endsWith(`__${toolName}`))
    ) {
      continue
    }
    const candidate: Candidate = {
      id: name,
      atMs,
      ...(isClaudeSessionId(record.prompt_id) ? { promptId: record.prompt_id } : {}),
    }
    if (!oldest || atMs < oldest.atMs) oldest = candidate
    if (canonicalJson(record.tool_input ?? {}) === wanted && (!exact || atMs < exact.atMs)) {
      exact = candidate
    }
  }
  const chosen = exact ?? oldest
  if (!chosen) return undefined
  removeQuietly(join(dir, chosen.id))
  return { toolUseId: chosen.id, ...(chosen.promptId !== undefined ? { promptId: chosen.promptId } : {}) }
}

/** A tool call's PreToolUse record, as {@link takeToolUse} hands it to the server. */
export type ToolUse = {
  /** The model's id for the call. */
  readonly toolUseId: string
  /** Claude Code's id for the turn that made the call, when it gave one. */
  readonly promptId?: string
}

/** JSON with object keys sorted, so two equal values give the same text. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  )
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Left for the next pass.
  }
}

/**
 * Remove the files of Claude Code processes that no longer exist. Run when
 * a server starts: a live Claude Code keeps its files across a restart of
 * its MCP server, so the restarted server still follows `/clear`; a Claude
 * Code that died without a clean shutdown leaves files a reused pid must
 * not inherit. Best effort.
 */
export function sweepDeadSessions(stateDir: string): void {
  let names: string[]
  try {
    names = readdirSync(sessionsDir(stateDir))
  } catch {
    return
  }
  for (const name of names) {
    const match = /^(\d+)(\.stop|\.turn|\.tools|\.open|\.nudge|\.events)?$/.exec(name)
    if (!match || processAlive(Number(match[1]))) continue
    removeQuietly(join(sessionsDir(stateDir), name))
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive, someone else's. Anything else: gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}


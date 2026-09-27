import {
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
 *   - `<pid>.stop`    Stop: `{ session_id, background, at_ms }`, the turn's
 *                     end, and whether background work could start another
 *   - `<pid>.turn`    PreToolUse, every tool call: `{ prompt_id, first_ms,
 *                     at_ms }`, the turn the latest call belongs to and when
 *                     that turn's first call was made
 *   - `<pid>.tools/`  PreToolUse, one file per agent-tool call:
 *                     `{ tool_use_id, tool_name, tool_input, at_ms }`
 *
 * Every file is written atomically (a rename), so a reader sees a whole
 * record or the previous one. The hooks write whether or not an extension
 * is loaded; nothing here depends on one.
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

/** The file the PreToolUse hook writes on every tool call: the current turn. */
export function turnFilePath(stateDir: string, pid: number | string): string {
  return join(sessionsDir(stateDir), `${pid}.turn`)
}

/** The directory the PreToolUse hook writes one file per tool call into. */
export function toolUsesDir(stateDir: string, pid: number | string): string {
  return join(sessionsDir(stateDir), `${pid}.tools`)
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

/**
 * Record one hook event for Claude Code process `pid`, from the hook's
 * input as Claude Code gave it. Returns what was written, or `undefined`
 * for an event this plugin does not record or a malformed input:
 * `'tool'` for an agent-tool call (its id file and the turn file),
 * `'turn'` for any other tool call (the turn file only).
 * `now` is the hook's clock, epoch milliseconds.
 */
export function recordHookEvent(
  stateDir: string,
  pid: number | string,
  input: Readonly<Record<string, unknown>>,
  now: number = Date.now(),
): 'session' | 'stop' | 'tool' | 'turn' | undefined {
  const event = input.hook_event_name
  const sessionId = isClaudeSessionId(input.session_id) ? input.session_id : undefined
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
    mkdirSync(sessionsDir(stateDir), { recursive: true })
    writeAtomically(
      stopFilePath(stateDir, pid),
      `${JSON.stringify({
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(background !== undefined ? { background } : {}),
        at_ms: now,
      })}\n`,
    )
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
// Reading: what the server makes of the files
// ─────────────────────────────────────────────────────────────────────────────

/** The session the SessionStart hook recorded last. */
export type SessionRecord = {
  readonly sessionId: string
  readonly source: string
  readonly atMs: number
}

/** The turn end the Stop hook recorded last. */
export type StopRecord = {
  readonly sessionId?: string
  /** Background work could start another turn; absent when Claude Code did not say. */
  readonly background?: boolean
  readonly atMs: number
}

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
  const value = readJson(stopFilePath(source.stateDir, source.parentPid))
  if (!value) return undefined
  const atMs = epochMs(value.at_ms)
  if (atMs === undefined) return undefined
  return {
    ...(isClaudeSessionId(value.session_id) ? { sessionId: value.session_id } : {}),
    ...(typeof value.background === 'boolean' ? { background: value.background } : {}),
    atMs,
  }
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
 * `undefined` when nothing matches.
 */
export function takeToolUse(
  source: SessionIdSource,
  toolName: string,
  args: unknown,
  now: number = Date.now(),
): string | undefined {
  const dir = toolUsesDir(source.stateDir, source.parentPid)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  const wanted = canonicalJson(args ?? {})
  let exact: { id: string; atMs: number } | undefined
  let oldest: { id: string; atMs: number } | undefined
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
    const candidate = { id: name, atMs }
    if (!oldest || atMs < oldest.atMs) oldest = candidate
    if (canonicalJson(record.tool_input ?? {}) === wanted && (!exact || atMs < exact.atMs)) {
      exact = candidate
    }
  }
  const chosen = exact ?? oldest
  if (chosen) removeQuietly(join(dir, chosen.id))
  return chosen?.id
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
    const match = /^(\d+)(\.stop|\.turn|\.tools)?$/.exec(name)
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


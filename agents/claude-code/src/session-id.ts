import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How the channel learns the Claude Code session id — the value Claude
 * Code sends on every model request, which a served record names as
 * `harness_thread_id`, bare, next to `harness: claude`.
 *
 * Claude Code puts the id in `CLAUDE_CODE_SESSION_ID` when it spawns the
 * MCP server, so the environment is the baseline. A session can change
 * under a running server, though: `/clear` starts a new session with a
 * new id and keeps the server. The plugin's SessionStart hook therefore
 * records the current id in the state directory, keyed by the Claude Code
 * process id, and the server reads that file before falling back to its
 * environment. Both are children of the same Claude Code process, which
 * hands both `CLAUDE_PID`; the server falls back to its parent pid.
 */

// Header-safe by construction: the id ends up in a JSON field a consumer
// matches against a request header the harness sent, so anything a header
// value could never hold — empty, whitespace, control characters — is
// refused rather than recorded. Claude Code's ids are UUIDs.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** `true` iff `value` is shaped like a session id Claude Code would send. */
export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

/** Directory of the per-Claude-process session files under the state dir. */
export function sessionsDir(stateDir: string): string {
  return join(stateDir, 'sessions')
}

/** The session file the hook writes for Claude Code process `pid`. */
export function sessionFilePath(stateDir: string, pid: number | string): string {
  return join(sessionsDir(stateDir), String(pid))
}

/** The file the Stop hook touches for Claude Code process `pid` when a turn ends. */
export function stopFilePath(stateDir: string, pid: number | string): string {
  return join(sessionsDir(stateDir), `${pid}.stop`)
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

/**
 * The current session id, or `undefined` when neither the hook file nor
 * the environment names one. The file wins when present and well-formed:
 * it is newer than the environment by construction. A missing or
 * unreadable file is not an error; a malformed one is ignored.
 */
export function resolveClaudeSessionId(source: SessionIdSource): string | undefined {
  const fromHook = readSessionFile(sessionFilePath(source.stateDir, source.parentPid))
  if (fromHook !== undefined) return fromHook
  const fromEnv = source.env.CLAUDE_CODE_SESSION_ID
  return isClaudeSessionId(fromEnv) ? fromEnv : undefined
}

/**
 * The last turn end the Stop hook recorded for the Claude Code process, in
 * epoch milliseconds as the hook wrote them — one value for ordering
 * against the reply that preceded it and for the record's timestamp, so
 * no file time is involved. `undefined` without a readable, well-formed
 * file.
 */
export function readTurnStop(source: SessionIdSource): number | undefined {
  let text: string
  try {
    text = readFileSync(stopFilePath(source.stateDir, source.parentPid), 'utf8')
  } catch {
    return undefined
  }
  const value = text.trim()
  return /^\d{1,16}$/.test(value) ? Number(value) : undefined
}

/**
 * Remove the session and Stop files of Claude Code processes that no
 * longer exist. Run when a server starts: a live Claude Code keeps its
 * files across a restart of its MCP server, so the restarted server still
 * follows `/clear`; a Claude Code that died without a clean shutdown
 * leaves files a reused pid must not inherit. Best effort.
 */
export function sweepDeadSessions(stateDir: string): void {
  let names: string[]
  try {
    names = readdirSync(sessionsDir(stateDir))
  } catch {
    return
  }
  for (const name of names) {
    const match = /^(\d+)(\.stop)?$/.exec(name)
    if (!match || processAlive(Number(match[1]))) continue
    try {
      rmSync(join(sessionsDir(stateDir), name), { force: true })
    } catch {
      // Left for the next sweep.
    }
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

/**
 * `true` iff the plugin's hooks are active for this Claude Code process —
 * the SessionStart hook has written its file — so a Stop hook can be
 * expected at the end of a turn.
 */
export function hooksActive(source: SessionIdSource): boolean {
  return existsSync(sessionFilePath(source.stateDir, source.parentPid))
}

function readSessionFile(path: string): string | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const value = text.trim()
  return isClaudeSessionId(value) ? value : undefined
}

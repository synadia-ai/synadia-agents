// The hooks' files: what the hook script writes for SessionStart, Stop and
// PreToolUse, and how the server reads them — the session id, the turn's
// end, the tool-call id for one call, the sweep of dead processes' files,
// and the poll that turns them into the extensions' session events.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TOOL_USE_MAX_AGE_MS,
  claudePid,
  hooksActive,
  readSessionRecord,
  readTurnStop,
  recordHookEvent,
  resolveClaudeSessionId,
  sessionFilePath,
  sessionsDir,
  stopFilePath,
  sweepDeadSessions,
  takeToolUse,
  toolUsesDir,
  type SessionIdSource,
} from '../src/session-id.js'
import { watchSessionEvents } from '../src/session-events.js'

const PID = 4242
const SESSION = '0b7e1c9a-2f4d-4e1b-9c3a-5d6e7f8a9b0c'

let stateDir: string
let source: SessionIdSource

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'claude-channel-sessions-'))
  source = { env: {}, stateDir, parentPid: PID }
})
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('recordHookEvent: what each hook writes', () => {
  test('SessionStart records the session id, its source and the time', () => {
    expect(recordHookEvent(stateDir, PID, {
      hook_event_name: 'SessionStart',
      session_id: SESSION,
      source: 'clear',
    }, 1000)).toBe('session')
    expect(readSessionRecord(source)).toEqual({ sessionId: SESSION, source: 'clear', atMs: 1000 })
    expect(hooksActive(source)).toBe(true)
  })

  test('Stop records the turn end with its session', () => {
    expect(recordHookEvent(stateDir, PID, { hook_event_name: 'Stop', session_id: SESSION }, 2000))
      .toBe('stop')
    expect(readTurnStop(source)).toEqual({ sessionId: SESSION, atMs: 2000 })
  })

  test('PreToolUse records one file per call, named by the tool-use id', () => {
    expect(recordHookEvent(stateDir, PID, {
      hook_event_name: 'PreToolUse',
      tool_use_id: 'toolu_01ABC',
      tool_name: 'mcp__plugin_nats-channel_nats__prompt_agent',
      tool_input: { address: 'a', prompt: 'p' },
    }, 3000)).toBe('tool')
    expect(readdirSync(toolUsesDir(stateDir, PID))).toEqual(['toolu_01ABC'])
  })

  test('malformed input writes nothing: a bad session id, a tool-use id that is a path, another event', () => {
    expect(recordHookEvent(stateDir, PID, { hook_event_name: 'SessionStart', session_id: 'a b' }))
      .toBeUndefined()
    expect(recordHookEvent(stateDir, PID, {
      hook_event_name: 'PreToolUse',
      tool_use_id: '../escape',
      tool_name: 'prompt_agent',
    })).toBeUndefined()
    expect(recordHookEvent(stateDir, PID, { hook_event_name: 'PostToolUse' })).toBeUndefined()
    expect(existsSync(sessionsDir(stateDir))).toBe(false)
  })
})

describe('reading the files', () => {
  test('the session id comes from the hook file first, then CLAUDE_CODE_SESSION_ID', () => {
    const withEnv = { ...source, env: { CLAUDE_CODE_SESSION_ID: 'from-env' } }
    expect(resolveClaudeSessionId(source)).toBeUndefined()
    expect(resolveClaudeSessionId(withEnv)).toBe('from-env')
    recordHookEvent(stateDir, PID, { hook_event_name: 'SessionStart', session_id: SESSION, source: 'startup' })
    expect(resolveClaudeSessionId(withEnv)).toBe(SESSION)
  })

  test('a malformed file reads as absent', () => {
    mkdirSync(sessionsDir(stateDir), { recursive: true })
    writeFileSync(sessionFilePath(stateDir, PID), 'not json')
    writeFileSync(stopFilePath(stateDir, PID), JSON.stringify({ at_ms: 'soon' }))
    expect(readSessionRecord(source)).toBeUndefined()
    expect(readTurnStop(source)).toBeUndefined()
  })

  test('CLAUDE_PID names the Claude Code process, else the parent pid', () => {
    expect(claudePid({ CLAUDE_PID: '77' }, 5)).toBe(77)
    expect(claudePid({ CLAUDE_PID: 'x' }, 5)).toBe(5)
    expect(claudePid({}, 5)).toBe(5)
  })
})

describe('takeToolUse: the PreToolUse id reaches the call it was recorded for', () => {
  const record = (id: string, name: string, input: unknown, atMs: number): void => {
    recordHookEvent(stateDir, PID, {
      hook_event_name: 'PreToolUse',
      tool_use_id: id,
      tool_name: name,
      tool_input: input,
    }, atMs)
  }

  test('matches the MCP tool name by its last segment and removes the record', () => {
    record('toolu_1', 'mcp__plugin_nats-channel_nats__discover_agents', {}, 1000)
    expect(takeToolUse(source, 'prompt_agent', {}, 1001)).toBeUndefined()
    expect(takeToolUse(source, 'discover_agents', {}, 1001)).toBe('toolu_1')
    expect(takeToolUse(source, 'discover_agents', {}, 1002)).toBeUndefined()
  })

  test('parallel calls of one tool each get the id whose input matches their arguments', () => {
    record('toolu_a', 'mcp__nats__prompt_agent', { address: 'x', prompt: 'one' }, 1000)
    record('toolu_b', 'mcp__nats__prompt_agent', { prompt: 'two', address: 'y' }, 1001)
    expect(takeToolUse(source, 'prompt_agent', { address: 'y', prompt: 'two' }, 1002)).toBe('toolu_b')
    expect(takeToolUse(source, 'prompt_agent', { address: 'x', prompt: 'one' }, 1002)).toBe('toolu_a')
  })

  test('without an input match the oldest record of the tool wins', () => {
    record('toolu_new', 'mcp__nats__prompt_agent', { prompt: 'n' }, 2000)
    record('toolu_old', 'mcp__nats__prompt_agent', { prompt: 'o' }, 1000)
    expect(takeToolUse(source, 'prompt_agent', { prompt: 'other' }, 2001)).toBe('toolu_old')
  })

  test('stale records are dropped, not handed to a later call', () => {
    record('toolu_stale', 'mcp__nats__prompt_agent', {}, 1000)
    expect(takeToolUse(source, 'prompt_agent', {}, 1000 + TOOL_USE_MAX_AGE_MS + 1)).toBeUndefined()
    expect(readdirSync(toolUsesDir(stateDir, PID))).toEqual([])
  })

  test('no directory means no id', () => {
    expect(takeToolUse(source, 'prompt_agent', {})).toBeUndefined()
  })
})

describe('sweepDeadSessions', () => {
  test("removes a dead process's files and keeps a live one's", () => {
    const dead = 2 ** 22 + 12345 // above any pid the system hands out here
    for (const pid of [dead, process.pid]) {
      recordHookEvent(stateDir, pid, { hook_event_name: 'SessionStart', session_id: SESSION })
      recordHookEvent(stateDir, pid, { hook_event_name: 'Stop' })
      recordHookEvent(stateDir, pid, { hook_event_name: 'PreToolUse', tool_use_id: 't1', tool_name: 'x' })
    }
    sweepDeadSessions(stateDir)
    expect(readdirSync(sessionsDir(stateDir)).sort()).toEqual(
      [`${process.pid}`, `${process.pid}.stop`, `${process.pid}.tools`].sort(),
    )
  })
})

describe('watchSessionEvents: the hooks as the extensions\' events', () => {
  test('a session recorded before start is reported once; a Stop recorded before start is not', () => {
    recordHookEvent(stateDir, PID, { hook_event_name: 'SessionStart', session_id: SESSION, source: 'startup' }, 10)
    recordHookEvent(stateDir, PID, { hook_event_name: 'Stop', session_id: SESSION }, 20)
    const calls: string[] = []
    const watcher = watchSessionEvents(source, {
      sessionStarted: (id, from) => calls.push(`started ${id} ${from}`),
      turnStopped: (id, at) => calls.push(`stopped ${id ?? '-'} ${at}`),
    }, 60_000)
    try {
      watcher.poll()
      expect(calls).toEqual([`started ${SESSION} startup`])

      recordHookEvent(stateDir, PID, { hook_event_name: 'Stop', session_id: SESSION }, 30)
      watcher.poll()
      recordHookEvent(stateDir, PID, { hook_event_name: 'SessionStart', session_id: 'next', source: 'clear' }, 40)
      recordHookEvent(stateDir, PID, { hook_event_name: 'Stop' }, 50)
      watcher.poll()
      watcher.poll()
      expect(calls).toEqual([
        `started ${SESSION} startup`,
        `stopped ${SESSION} 30`,
        'started next clear',
        // A Stop without a session id is the current session's.
        'stopped next 50',
      ])
    } finally {
      watcher.stop()
    }
  })

  test('the timer polls on its own', async () => {
    const calls: string[] = []
    const watcher = watchSessionEvents(source, {
      sessionStarted: () => undefined,
      turnStopped: (_id, at) => calls.push(`stopped ${at}`),
    }, 10)
    try {
      recordHookEvent(stateDir, PID, { hook_event_name: 'Stop' }, 99)
      for (let i = 0; i < 50 && calls.length === 0; i++) await Bun.sleep(10)
      expect(calls).toEqual(['stopped 99'])
    } finally {
      watcher.stop()
    }
  })
})

describe('hooks/session-event.ts: the script Claude Code runs', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'session-event.ts')

  async function runHook(input: string, env: Record<string, string>): Promise<{ code: number; stdout: string }> {
    const child = Bun.spawn([process.execPath, script], {
      stdin: new TextEncoder().encode(input),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', ...env },
    })
    const stdout = await new Response(child.stdout).text()
    return { code: await child.exited, stdout }
  }

  test('writes under NATS_STATE_DIR keyed by CLAUDE_PID, prints nothing and exits 0', async () => {
    const env = { CLAUDE_PID: String(PID), NATS_STATE_DIR: stateDir }
    expect(await runHook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: SESSION, source: 'resume' }), env))
      .toEqual({ code: 0, stdout: '' })
    expect(await runHook(JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: SESSION,
      tool_use_id: 'toolu_hook',
      tool_name: 'mcp__nats__prompt_agent',
      tool_input: { address: 'a', prompt: 'p' },
    }), env)).toEqual({ code: 0, stdout: '' })
    expect(readSessionRecord(source)).toMatchObject({ sessionId: SESSION, source: 'resume' })
    expect(takeToolUse(source, 'prompt_agent', { address: 'a', prompt: 'p' })).toBe('toolu_hook')
  })

  test('garbage input or no CLAUDE_PID still exits 0 and writes nothing', async () => {
    expect((await runHook('not json', { CLAUDE_PID: String(PID), NATS_STATE_DIR: stateDir })).code).toBe(0)
    expect((await runHook(JSON.stringify({ hook_event_name: 'Stop' }), { NATS_STATE_DIR: stateDir })).code).toBe(0)
    expect(existsSync(sessionsDir(stateDir))).toBe(false)
  })
})

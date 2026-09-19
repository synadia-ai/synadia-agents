import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  claudePid,
  hooksActive,
  isClaudeSessionId,
  readTurnStop,
  resolveClaudeSessionId,
  sessionFilePath,
  sessionsDir,
  stopFilePath,
  sweepDeadSessions,
} from '../src/session-id.js'

const SESSION = '317f624b-c7c6-4b27-936b-c0de80892e6d'
const NEWER = '9d0b2c4e-1111-4222-8333-444455556666'
const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'session-event.ts')

function withStateDir(run: (stateDir: string) => void): void {
  const stateDir = mkdtempSync(join(tmpdir(), 'claude-channel-session-'))
  try {
    run(stateDir)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
}

describe('isClaudeSessionId', () => {
  test('accepts a UUID and other header-safe ids, rejects the rest', () => {
    expect(isClaudeSessionId(SESSION)).toBe(true)
    expect(isClaudeSessionId('abc_123.x:y')).toBe(true)
    expect(isClaudeSessionId(undefined)).toBe(false)
    expect(isClaudeSessionId(42)).toBe(false)
    expect(isClaudeSessionId('')).toBe(false)
    expect(isClaudeSessionId('-leading')).toBe(false)
    expect(isClaudeSessionId('has space')).toBe(false)
    expect(isClaudeSessionId('a\nb')).toBe(false)
    expect(isClaudeSessionId('a'.repeat(128))).toBe(true)
    expect(isClaudeSessionId('a'.repeat(129))).toBe(false)
  })
})

describe('resolveClaudeSessionId', () => {
  test('falls back to the environment when no hook file exists', () => {
    withStateDir(stateDir => {
      expect(resolveClaudeSessionId({
        env: { CLAUDE_CODE_SESSION_ID: SESSION },
        stateDir,
        parentPid: 4242,
      })).toBe(SESSION)
      expect(resolveClaudeSessionId({ env: {}, stateDir, parentPid: 4242 })).toBeUndefined()
      expect(resolveClaudeSessionId({
        env: { CLAUDE_CODE_SESSION_ID: 'not a session' },
        stateDir,
        parentPid: 4242,
      })).toBeUndefined()
    })
  })

  test('the hook file for the parent pid wins over the environment', () => {
    withStateDir(stateDir => {
      mkdirSync(sessionsDir(stateDir), { recursive: true })
      writeFileSync(sessionFilePath(stateDir, 4242), `${NEWER}\n`)
      const env = { CLAUDE_CODE_SESSION_ID: SESSION }
      expect(resolveClaudeSessionId({ env, stateDir, parentPid: 4242 })).toBe(NEWER)
      // Another Claude Code process's file is not this server's.
      expect(resolveClaudeSessionId({ env, stateDir, parentPid: 4243 })).toBe(SESSION)
    })
  })

  test('a malformed hook file is ignored, not an error', () => {
    withStateDir(stateDir => {
      mkdirSync(sessionsDir(stateDir), { recursive: true })
      writeFileSync(sessionFilePath(stateDir, 4242), 'garbage id\n')
      expect(resolveClaudeSessionId({
        env: { CLAUDE_CODE_SESSION_ID: SESSION },
        stateDir,
        parentPid: 4242,
      })).toBe(SESSION)
    })
  })
})

describe('readTurnStop and hooksActive', () => {
  test('hooks are active once the SessionStart file exists', () => {
    withStateDir(stateDir => {
      const source = { env: {}, stateDir, parentPid: 4242 }
      expect(hooksActive(source)).toBe(false)
      mkdirSync(sessionsDir(stateDir), { recursive: true })
      writeFileSync(sessionFilePath(stateDir, 4242), `${SESSION}\n`)
      expect(hooksActive(source)).toBe(true)
    })
  })

  test('reads the Stop file as epoch milliseconds, ignores garbage and emptiness', () => {
    withStateDir(stateDir => {
      const source = { env: {}, stateDir, parentPid: 4242 }
      expect(readTurnStop(source)).toBeUndefined()
      mkdirSync(sessionsDir(stateDir), { recursive: true })
      writeFileSync(stopFilePath(stateDir, 4242), '1700000000123\n')
      expect(readTurnStop(source)).toBe(1_700_000_000_123)
      for (const bad of ['-5\n', 'later\n', '', '  \n', '1.5\n', '9'.repeat(17)]) {
        writeFileSync(stopFilePath(stateDir, 4242), bad)
        expect(readTurnStop(source)).toBeUndefined()
      }
    })
  })

  test('claudePid prefers CLAUDE_PID over the parent pid', () => {
    expect(claudePid({ CLAUDE_PID: '4242' }, 7)).toBe(4242)
    expect(claudePid({}, 7)).toBe(7)
    expect(claudePid({ CLAUDE_PID: 'x' }, 7)).toBe(7)
  })

  test('sweepDeadSessions removes files of dead processes and keeps live ones', () => {
    withStateDir(stateDir => {
      mkdirSync(sessionsDir(stateDir), { recursive: true })
      // This test process is alive; a pid beyond the kernel's range is not.
      const dead = 4_194_305
      writeFileSync(sessionFilePath(stateDir, process.pid), `${SESSION}\n`)
      writeFileSync(stopFilePath(stateDir, process.pid), '1\n')
      writeFileSync(sessionFilePath(stateDir, dead), `${SESSION}\n`)
      writeFileSync(stopFilePath(stateDir, dead), '1\n')
      writeFileSync(join(sessionsDir(stateDir), 'unrelated.txt'), 'keep\n')
      sweepDeadSessions(stateDir)
      expect(existsSync(sessionFilePath(stateDir, process.pid))).toBe(true)
      expect(existsSync(stopFilePath(stateDir, process.pid))).toBe(true)
      expect(existsSync(sessionFilePath(stateDir, dead))).toBe(false)
      expect(existsSync(stopFilePath(stateDir, dead))).toBe(false)
      expect(existsSync(join(sessionsDir(stateDir), 'unrelated.txt'))).toBe(true)
      // A missing directory is not an error.
      sweepDeadSessions(join(stateDir, 'nowhere'))
    })
  })
})

describe('the hook script', () => {
  function runHook(input: string, env: Record<string, string>) {
    return spawnSync('bun', [HOOK], {
      input,
      env: { ...process.env, NATS_TRACING: 'on', ...env },
      encoding: 'utf8',
    })
  }

  test('writes nothing with tracing off', () => {
    withStateDir(stateDir => {
      const result = runHook(
        JSON.stringify({ session_id: NEWER, hook_event_name: 'SessionStart', source: 'startup' }),
        { CLAUDE_PID: '4242', NATS_STATE_DIR: stateDir, NATS_TRACING: 'off' },
      )
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(existsSync(sessionsDir(stateDir))).toBe(false)
      // A malformed config.json is not an error for a hook either.
      writeFileSync(join(stateDir, 'config.json'), '{')
      const broken = runHook(
        JSON.stringify({ session_id: NEWER, hook_event_name: 'SessionStart', source: 'startup' }),
        { CLAUDE_PID: '4242', NATS_STATE_DIR: stateDir },
      )
      expect(broken.status).toBe(0)
      expect(existsSync(sessionsDir(stateDir))).toBe(false)
    })
  })

  test('records the session id for the Claude Code process, silently', () => {
    withStateDir(stateDir => {
      const result = runHook(
        JSON.stringify({ session_id: NEWER, hook_event_name: 'SessionStart', source: 'clear' }),
        { CLAUDE_PID: '4242', NATS_STATE_DIR: stateDir },
      )
      expect(result.status).toBe(0)
      // Anything on stdout would enter the model's context.
      expect(result.stdout).toBe('')
      expect(readFileSync(sessionFilePath(stateDir, 4242), 'utf8')).toBe(`${NEWER}\n`)
      expect(resolveClaudeSessionId({ env: {}, stateDir, parentPid: 4242 })).toBe(NEWER)
    })
  })

  test('records a turn end on Stop, keyed by the Claude Code process', () => {
    withStateDir(stateDir => {
      const before = Date.now()
      const result = runHook(
        JSON.stringify({ session_id: NEWER, hook_event_name: 'Stop', stop_hook_active: false }),
        { CLAUDE_PID: '4242', NATS_STATE_DIR: stateDir },
      )
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      const stop = readTurnStop({ env: {}, stateDir, parentPid: 4242 })
      expect(stop).toBeGreaterThanOrEqual(before)
      expect(stop).toBeLessThanOrEqual(Date.now())
      // A Stop names no session: the session file is the SessionStart hook's.
      expect(existsSync(sessionFilePath(stateDir, 4242))).toBe(false)
    })
  })

  test('exits 0 and writes nothing on a malformed payload or without CLAUDE_PID', () => {
    withStateDir(stateDir => {
      const bad = runHook('not json', { CLAUDE_PID: '4242', NATS_STATE_DIR: stateDir })
      expect(bad.status).toBe(0)
      expect(bad.stdout).toBe('')
      expect(existsSync(sessionFilePath(stateDir, 4242))).toBe(false)

      const unshaped = runHook(
        JSON.stringify({ session_id: 'not a session' }),
        { CLAUDE_PID: '4242', NATS_STATE_DIR: stateDir },
      )
      expect(unshaped.status).toBe(0)
      expect(existsSync(sessionFilePath(stateDir, 4242))).toBe(false)

      const env: Record<string, string> = { NATS_STATE_DIR: stateDir, NATS_TRACING: 'on' }
      const orphan = spawnSync('bun', [HOOK], {
        input: JSON.stringify({ session_id: NEWER }),
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_PID')), ...env },
        encoding: 'utf8',
      })
      expect(orphan.status).toBe(0)
      expect(existsSync(sessionsDir(stateDir))).toBe(false)
    })
  })
})

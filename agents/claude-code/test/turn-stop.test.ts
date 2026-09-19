import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionFilePath, sessionsDir, stopFilePath, type SessionIdSource } from '../src/session-id.js'
import { turnStopWaiter } from '../src/turn-stop.js'

const PID = 4242
const SESSION = '317f624b-c7c6-4b27-936b-c0de80892e6d'

function withSource(run: (source: SessionIdSource) => Promise<void>): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), 'claude-channel-stop-'))
  return run({ env: {}, stateDir, parentPid: PID }).finally(() =>
    rmSync(stateDir, { recursive: true, force: true }),
  )
}

function activateHooks(source: SessionIdSource): void {
  mkdirSync(sessionsDir(source.stateDir), { recursive: true })
  writeFileSync(sessionFilePath(source.stateDir, PID), `${SESSION}\n`)
}

function recordStop(source: SessionIdSource, atMs: number = Date.now()): void {
  writeFileSync(stopFilePath(source.stateDir, PID), `${atMs}\n`)
}

describe('turnStopWaiter', () => {
  test('without active hooks the reply is the turn end: resolves at once', () =>
    withSource(async source => {
      const started = Date.now()
      expect(await turnStopWaiter(source, Date.now(), 5_000, 10).wait()).toBeUndefined()
      expect(Date.now() - started).toBeLessThan(500)
    }))

  test('resolves with the Stop recorded after the reply', () =>
    withSource(async source => {
      activateHooks(source)
      const waiter = turnStopWaiter(source, Date.now(), 5_000, 10)
      const waiting = waiter.wait()
      await Bun.sleep(50)
      const stoppedAt = Date.now() + 5
      recordStop(source, stoppedAt)
      expect(await waiting).toBe(Math.floor(stoppedAt / 1000))
    }))

  test('a Stop older than the reply belongs to an earlier turn and is ignored', () =>
    withSource(async source => {
      activateHooks(source)
      recordStop(source, Date.now() - 10_000)
      const waiter = turnStopWaiter(source, Date.now(), 200, 10)
      expect(await waiter.wait()).toBeUndefined()
    }))

  test('gives up at the limit', () =>
    withSource(async source => {
      activateHooks(source)
      const started = Date.now()
      expect(await turnStopWaiter(source, Date.now(), 150, 10).wait()).toBeUndefined()
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(140)
      expect(elapsed).toBeLessThan(2_000)
    }))

  test('cancel ends the wait now', () =>
    withSource(async source => {
      activateHooks(source)
      const waiter = turnStopWaiter(source, Date.now(), 60_000, 10)
      const waiting = waiter.wait()
      await Bun.sleep(30)
      waiter.cancel()
      expect(await waiting).toBeUndefined()
    }))

  test('a malformed or empty Stop file is ignored', () =>
    withSource(async source => {
      activateHooks(source)
      for (const content of ['soon\n', '', '\n', '-5\n', '1.5\n']) {
        writeFileSync(stopFilePath(source.stateDir, PID), content)
        expect(await turnStopWaiter(source, Date.now() - 1_000, 100, 10).wait()).toBeUndefined()
      }
    }))
})

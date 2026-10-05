// Which served prompt a permission question belongs to: the one whose
// turn made the tool call, when that is certain, and none otherwise.

import { describe, expect, test } from 'bun:test'
import { TurnLedger, type TurnView } from '../src/permission-routing.js'
import type { StopRecord, TurnActivity } from '../src/session-id.js'

const idleStop = (atMs: number): StopRecord => ({ atMs, background: false })
const call = (promptId: string, firstMs: number, atMs: number = firstMs): TurnActivity => ({
  promptId,
  firstMs,
  atMs,
})
const view = (stop: StopRecord | undefined, activity?: TurnActivity, hooksActive = true): TurnView => ({
  stop,
  activity,
  hooksActive,
})

function ledger(finished: Set<string> = new Set()): TurnLedger {
  return new TurnLedger(requestId => finished.has(requestId))
}

describe('TurnLedger: a prompt delivered to a quiet Claude Code owns the turn it starts', () => {
  test("the turn's questions go to it", () => {
    const turns = ledger()
    expect(turns.delivered('1', view(idleStop(100)), 200)).toBe(true)
    expect(turns.ownerOf(view(idleStop(100), call('p1', 300)))).toEqual({ kind: 'owner', requestId: '1' })
    expect(turns.ownerOf(view(idleStop(100), call('p1', 300, 900)))).toEqual({ kind: 'owner', requestId: '1' })
  })

  test('a fresh session, before any Stop, is quiet', () => {
    const turns = ledger()
    expect(turns.delivered('1', view(undefined), 200)).toBe(true)
    expect(turns.ownerOf(view(undefined, call('p1', 300)))).toEqual({ kind: 'owner', requestId: '1' })
  })

  test('after its Stop, a later turn is not its own', () => {
    const turns = ledger()
    turns.delivered('1', view(idleStop(100)), 200)
    turns.ownerOf(view(idleStop(100), call('p1', 300)))
    // The turn ended; background work started another with no prompt.
    expect(turns.ownerOf(view(idleStop(400), call('p2', 500)))).toMatchObject({ kind: 'none' })
    // The watcher saw the Stop first: the same.
    const watched = ledger()
    watched.delivered('1', view(idleStop(100)), 200)
    watched.observeStop({ atMs: 400 })
    expect(watched.ownerOf(view(idleStop(400), call('p1', 500)))).toMatchObject({ kind: 'none' })
  })

  test('a prompt id that changes without a Stop ends the ownership', () => {
    const turns = ledger()
    turns.delivered('1', view(idleStop(100)), 200)
    expect(turns.ownerOf(view(idleStop(100), call('p1', 300)))).toMatchObject({ kind: 'owner' })
    expect(turns.ownerOf(view(idleStop(100), call('p2', 300, 600)))).toEqual({
      kind: 'none',
      reason: 'the turn changed without a Stop',
    })
  })

  test('a forgotten request owns nothing', () => {
    const turns = ledger()
    turns.delivered('1', view(idleStop(100)), 200)
    turns.forget('1')
    expect(turns.ownerOf(view(idleStop(100), call('p1', 300)))).toMatchObject({ kind: 'none' })
  })
})

describe('TurnLedger: a new prompt never gets an older turn\'s question', () => {
  test('a prompt delivered while a turn runs owns nothing in it', () => {
    const turns = ledger()
    expect(turns.delivered('1', view(idleStop(100)), 200)).toBe(true)
    // The first turn is working when the second prompt arrives.
    expect(turns.delivered('2', view(idleStop(100), call('p1', 300)), 400)).toBe(false)
    expect(turns.ownerOf(view(idleStop(100), call('p1', 300, 500)))).toEqual({ kind: 'owner', requestId: '1' })
  })

  test('a turn that continues after its prompt\'s Stop asks nobody, not the prompt that arrives meanwhile', () => {
    const turns = ledger()
    turns.delivered('1', view(idleStop(100)), 200)
    // Stop at 400; background work starts a turn with no prompt at 500.
    expect(turns.delivered('2', view(idleStop(400), call('p2', 500)), 600)).toBe(false)
    expect(turns.ownerOf(view(idleStop(400), call('p2', 500, 700)))).toMatchObject({ kind: 'none' })
  })

  test('the second of two prompts delivered before any tool call owns nothing', () => {
    const turns = ledger()
    expect(turns.delivered('1', view(idleStop(100)), 200)).toBe(true)
    expect(turns.delivered('2', view(idleStop(100)), 250)).toBe(false)
    expect(turns.ownerOf(view(idleStop(100), call('p1', 300)))).toEqual({ kind: 'owner', requestId: '1' })
  })

  test('a prompt that may still be queued holds back the next one until a second Stop or its end', () => {
    const finished = new Set<string>()
    const turns = ledger(finished)
    turns.delivered('1', view(idleStop(100)), 200)
    // '2' arrives mid-turn: folded in, or queued for the next turn.
    expect(turns.delivered('2', view(idleStop(100), call('p1', 300)), 400)).toBe(false)
    // After the first turn's Stop, '3' looks quiet but '2' may own what runs.
    expect(turns.delivered('3', view(idleStop(500)), 600)).toBe(false)
    expect(turns.ownerOf(view(idleStop(500), call('p2', 700)))).toMatchObject({ kind: 'none' })
    // A second Stop: '2' was taken by now. '3', delivered while that was
    // unclear, may be queued the same way until it ends.
    finished.add('3')
    expect(turns.delivered('4', view(idleStop(800)), 900)).toBe(true)
    // Or '2' ended: it holds nothing back.
    const other = ledger(finished)
    other.delivered('1', view(idleStop(100)), 200)
    other.delivered('2', view(idleStop(100), call('p1', 300)), 400)
    finished.add('2')
    expect(other.delivered('3', view(idleStop(500)), 600)).toBe(true)
  })
})

describe('TurnLedger: anything uncertain is quiet for nobody', () => {
  test('background work at the last Stop, or a Stop that does not say', () => {
    expect(ledger().delivered('1', view({ atMs: 100, background: true }), 200)).toBe(false)
    expect(ledger().delivered('1', view({ atMs: 100 }), 200)).toBe(false)
  })

  test('no hooks', () => {
    const turns = ledger()
    expect(turns.delivered('1', view(idleStop(100), undefined, false), 200)).toBe(false)
    expect(turns.ownerOf(view(idleStop(100), call('p1', 300), false))).toMatchObject({ kind: 'none' })
  })

  test('no tool call recorded since the Stop, or one without a prompt id', () => {
    const turns = ledger()
    turns.delivered('1', view(idleStop(100)), 200)
    expect(turns.ownerOf(view(idleStop(100)))).toEqual({
      kind: 'none',
      reason: 'no tool call recorded for the current turn',
    })
    expect(turns.ownerOf(view(idleStop(100), { firstMs: 300, atMs: 300 }))).toEqual({
      kind: 'none',
      reason: 'the tool call carries no prompt id',
    })
  })
})

describe('TurnLedger: a turn that ends without the done reply ends its prompt', () => {
  const GRACE = 1000
  const busyStop = (atMs: number): StopRecord => ({ atMs, background: true })

  test('a prompt that owned its turn is ended at that turn\'s Stop', () => {
    const turns = ledger()
    expect(turns.delivered('1', view(idleStop(100)), 200)).toBe(true)
    // The turn runs: nothing to end before its Stop.
    expect(turns.unanswered(view(idleStop(100), call('p1', 300)), 400, GRACE)).toEqual([])
    // It stops with nothing in the background and no reply.
    expect(turns.unanswered(view(idleStop(500), call('p1', 300)), 501, GRACE)).toEqual([
      { requestId: '1', reason: 'its turn ended' },
    ])
    // The watcher saw the Stop first: the same.
    const watched = ledger()
    watched.delivered('1', view(idleStop(100)), 200)
    watched.observeStop(idleStop(500))
    expect(watched.unanswered(view(idleStop(500)), 501, GRACE)).toEqual([
      { requestId: '1', reason: 'its turn ended' },
    ])
  })

  test('the turn\'s final text comes with a prompt that owned it; the Stop hook learns who owns the turn', () => {
    const finished = new Set<string>()
    const turns = ledger(finished)
    expect(turns.owning()).toEqual([])
    turns.delivered('1', view(idleStop(100)), 200)
    expect(turns.owning()).toEqual(['1'])
    const stop: StopRecord = { atMs: 500, background: false, finalText: 'the answer' }
    expect(turns.unanswered(view(stop, call('p1', 300)), 501, GRACE)).toEqual([
      { requestId: '1', reason: 'its turn ended', finalText: 'the answer' },
    ])
    // Past its Stop it owns no turn; nor does a finished one.
    expect(turns.owning()).toEqual([])
    turns.delivered('2', view(stop), 600)
    expect(turns.owning()).toEqual(['2'])
    finished.add('2')
    expect(turns.owning()).toEqual([])
  })

  test('a prompt with its done reply is left alone', () => {
    const finished = new Set<string>()
    const turns = ledger(finished)
    turns.delivered('1', view(idleStop(100)), 200)
    finished.add('1')
    expect(turns.unanswered(view(idleStop(500)), 501, GRACE)).toEqual([])
    expect(turns.unanswered(view(idleStop(500)), 500 + 10 * GRACE, GRACE)).toEqual([])
  })

  test('a prompt delivered while a turn runs survives that Stop and is ended at its grace period', () => {
    const turns = ledger()
    turns.delivered('1', view(idleStop(100)), 200)
    // '2' arrives mid-turn: folded in, or queued for the next turn.
    expect(turns.delivered('2', view(idleStop(100), call('p1', 300)), 400)).toBe(false)
    // '1' replied; the turn stops. '2' is not ended at that Stop...
    const stopped = view(idleStop(500), call('p1', 300))
    expect(turns.unanswered(stopped, 501, GRACE).map(e => e.requestId)).toEqual(['1'])
    const finished = ledger(new Set(['1']))
    finished.delivered('1', view(idleStop(100)), 200)
    finished.delivered('2', view(idleStop(100), call('p1', 300)), 400)
    expect(finished.unanswered(stopped, 501, GRACE)).toEqual([])
    expect(finished.unanswered(stopped, 500 + GRACE - 1, GRACE)).toEqual([])
    // ...but once the grace period passes with no turn started, it is.
    expect(finished.unanswered(stopped, 500 + GRACE, GRACE)).toEqual([
      { requestId: '2', reason: 'no turn started for it' },
    ])
  })

  test('a turn that starts within the grace period keeps it open until the next Stop', () => {
    const turns = ledger(new Set(['1']))
    turns.delivered('1', view(idleStop(100)), 200)
    turns.delivered('2', view(idleStop(100), call('p1', 300)), 400)
    // The queued prompt's turn starts after the Stop at 500 and runs long.
    const running = view(idleStop(500), call('p2', 800))
    expect(turns.unanswered(running, 500 + 10 * GRACE, GRACE)).toEqual([])
    // It stops without the reply: the grace period runs from that Stop.
    const stopped = view(idleStop(20_000), call('p2', 800))
    expect(turns.unanswered(stopped, 20_000 + GRACE - 1, GRACE)).toEqual([])
    expect(turns.unanswered(stopped, 20_000 + GRACE, GRACE)).toEqual([
      { requestId: '2', reason: 'no turn started for it' },
    ])
  })

  test('background work left at the Stop turns an owned prompt into one with a grace period', () => {
    const turns = ledger()
    turns.delivered('1', view(idleStop(100)), 200)
    expect(turns.unanswered(view(busyStop(500)), 501, GRACE)).toEqual([])
    // Background work starts a turn that may still reply.
    expect(turns.unanswered(view(busyStop(500), call('p1', 900)), 500 + GRACE, GRACE)).toEqual([])
    expect(turns.unanswered(view(idleStop(1500), call('p1', 900)), 1500 + GRACE, GRACE)).toEqual([
      { requestId: '1', reason: 'no turn started for it' },
    ])
  })

  test('the TTL stays the last guard: no Stop, no hooks, or a turn after every Stop ends nothing', () => {
    // Delivered, and no Stop comes.
    const running = ledger()
    running.delivered('1', view(idleStop(100)), 200)
    expect(running.unanswered(view(idleStop(100), call('p1', 300)), 200 + 100 * GRACE, GRACE)).toEqual([])
    // No hooks: no Stop is ever recorded.
    const noHooks = ledger()
    noHooks.delivered('1', view(undefined, undefined, false), 200)
    expect(noHooks.unanswered(view(undefined, undefined, false), 200 + 100 * GRACE, GRACE)).toEqual([])
    // A busy session: each Stop is followed by a turn within the grace period.
    const busy = ledger(new Set(['1']))
    busy.delivered('1', view(idleStop(100)), 200)
    busy.delivered('2', view(idleStop(100), call('p1', 300)), 400)
    for (let stop = 500; stop < 500 + 100 * GRACE; stop += 2 * GRACE) {
      expect(busy.unanswered(view(idleStop(stop), call('px', stop + GRACE / 2)), stop + 2 * GRACE - 1, GRACE)).toEqual([])
    }
  })
})

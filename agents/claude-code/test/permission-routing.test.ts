// Which served prompt a permission question belongs to: the one whose
// turn made the tool call, when that is certain, and none otherwise.

import { describe, expect, test } from 'bun:test'
import { TurnLedger, turnFailedDescription, type TurnView } from '../src/permission-routing.js'
import type { FailureRecord, StopRecord, TurnActivity } from '../src/session-id.js'

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

  test('a Stop older than one already counted counts not at all', () => {
    const turns = ledger()
    // The read of `.stop` saw the later Stop first; the log's earlier one
    // arrives after it and must not end the new prompt's turn.
    turns.observeStop(idleStop(100))
    expect(turns.delivered('1', view(idleStop(150)), 200)).toBe(true)
    turns.observeStop(idleStop(120))
    turns.observeStop(idleStop(150))
    expect(turns.owning()).toEqual(['1'])
    expect(turns.ownerOf(view(idleStop(150), call('p1', 300)))).toEqual({ kind: 'owner', requestId: '1' })
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

describe('TurnLedger by prompt id: a prompt owns the turn it was taken into', () => {
  const GRACE = 1000
  const busyStop = (atMs: number): StopRecord => ({ atMs, background: true })
  function binding(finished: Set<string> = new Set()): TurnLedger {
    const turns = ledger(finished)
    turns.startBinding()
    return turns
  }

  test('the measured run-3 sequence: a prompt queued behind a typed turn owns nothing there, then its own turn', () => {
    const turns = binding()
    // TYPED-L runs (no tool call yet: the fallback would have called this
    // quiet); NATS-M is delivered meanwhile.
    turns.delivered('2', view(idleStop(100)), 200)
    expect(turns.owning()).toEqual([])
    expect(turns.open()).toEqual(['2'])
    // The typed turn's Stop: the queued prompt is not ended, gets no text.
    const typedStop: StopRecord = { atMs: 300, background: false, finalText: 'the typed answer' }
    turns.observeStop(typedStop)
    turns.turnEnded('pTyped', { kind: 'stop', stop: typedStop })
    expect(turns.unanswered(view(typedStop), 301, GRACE)).toEqual([])
    // Its own turn: taken in under a new id, it owns it.
    turns.bind('2', 'pM')
    expect(turns.owning()).toEqual(['2'])
    expect(turns.ownerOf(view(typedStop, call('pM', 400)))).toEqual({ kind: 'owner', requestId: '2' })
    // That turn stops without the reply: ended with its own final text.
    const ownStop: StopRecord = { atMs: 500, background: false, finalText: 'the NATS answer' }
    turns.observeStop(ownStop)
    turns.turnEnded('pM', { kind: 'stop', stop: ownStop })
    expect(turns.unanswered(view(ownStop), 501, GRACE)).toEqual([
      { requestId: '2', reason: 'its turn ended', finalText: 'the NATS answer' },
    ])
    expect(turns.owning()).toEqual([])
  })

  test('a fold: the prompt bound to the running id owns that turn\'s questions; the typed turn\'s before it are nobody\'s', () => {
    const turns = binding()
    turns.delivered('1', view(idleStop(100), call('pT', 150)), 200)
    expect(turns.ownerOf(view(idleStop(100), call('pT', 150, 180)))).toMatchObject({ kind: 'none' })
    turns.bind('1', 'pT')
    expect(turns.ownerOf(view(idleStop(100), call('pT', 150, 900)))).toEqual({ kind: 'owner', requestId: '1' })
  })

  test('a binding overrides the fallback\'s guess made before it', () => {
    const turns = ledger()
    // Delivered to a quiet Claude Code: the guess says it starts the next turn.
    expect(turns.delivered('1', view(idleStop(100)), 200)).toBe(true)
    turns.startBinding()
    // Not yet taken: owns nothing, whatever the guess.
    expect(turns.owning()).toEqual([])
    expect(turns.ownerOf(view(idleStop(100), call('pT', 300)))).toMatchObject({ kind: 'none' })
    turns.bind('1', 'pC')
    expect(turns.ownerOf(view(idleStop(100), call('pC', 400)))).toEqual({ kind: 'owner', requestId: '1' })
  })

  test('two prompts folded into one turn: its questions are denied', () => {
    const finished = new Set<string>()
    const turns = binding(finished)
    turns.delivered('1', view(idleStop(100)), 200)
    turns.delivered('2', view(idleStop(100)), 210)
    turns.bind('1', 'pS')
    turns.bind('2', 'pS')
    expect(turns.ownerOf(view(idleStop(100), call('pS', 300)))).toEqual({
      kind: 'none',
      reason: 'several served prompts share the current turn',
    })
    // One answered: the other is the turn's only open prompt.
    finished.add('1')
    expect(turns.ownerOf(view(idleStop(100), call('pS', 300, 400)))).toEqual({ kind: 'owner', requestId: '2' })
  })

  test('a failure or the next turn ends a bound prompt with an error, at once, without text', () => {
    const turns = binding()
    turns.delivered('1', view(idleStop(100)), 200)
    turns.delivered('2', view(idleStop(100)), 210)
    turns.bind('1', 'pF')
    turns.bind('2', 'pI')
    turns.turnEnded('pF', { kind: 'failure' })
    turns.turnEnded('pI', { kind: 'next' })
    // No Stop is needed, nor a grace period.
    expect(turns.unanswered(view(idleStop(100)), 220, GRACE)).toEqual([
      { requestId: '1', reason: 'its turn failed' },
      { requestId: '2', reason: 'another turn began' },
    ])
    // A fresh session with no Stop at all: the same.
    const fresh = binding()
    fresh.delivered('1', view(undefined), 200)
    fresh.bind('1', 'pF')
    fresh.turnEnded('pF', { kind: 'failure' })
    expect(fresh.unanswered(view(undefined), 201, GRACE)).toEqual([{ requestId: '1', reason: 'its turn failed' }])
  })

  test('the Stop of another turn, or one with background work left, does not end a bound prompt at once', () => {
    const turns = binding()
    turns.delivered('1', view(idleStop(100)), 200)
    turns.bind('1', 'pA')
    // A Stop of another turn: nothing.
    turns.observeStop(idleStop(300))
    turns.turnEnded('pOther', { kind: 'stop', stop: idleStop(300) })
    expect(turns.unanswered(view(idleStop(300)), 300 + 10 * GRACE, GRACE)).toEqual([])
    // Its own Stop with background work left: the grace rule decides.
    turns.observeStop(busyStop(400))
    turns.turnEnded('pA', { kind: 'stop', stop: busyStop(400) })
    expect(turns.owning()).toEqual([])
    expect(turns.unanswered(view(busyStop(400)), 401, GRACE)).toEqual([])
    expect(turns.unanswered(view(busyStop(400), call('pB', 900)), 400 + GRACE, GRACE)).toEqual([])
    expect(turns.unanswered(view(idleStop(1500), call('pB', 900)), 1500 + GRACE, GRACE)).toEqual([
      { requestId: '1', reason: 'no turn started for it' },
    ])
  })

  test('a prompt never taken into a turn keeps the grace rule; shutdown ends nothing here', () => {
    const turns = binding()
    turns.delivered('1', view(idleStop(100), call('pT', 150)), 200)
    turns.observeStop(idleStop(300))
    turns.turnEnded('pT', { kind: 'stop', stop: idleStop(300) })
    turns.turnEnded('pT', { kind: 'shutdown' })
    expect(turns.unanswered(view(idleStop(300)), 300 + GRACE - 1, GRACE)).toEqual([])
    expect(turns.unanswered(view(idleStop(300)), 300 + GRACE, GRACE)).toEqual([
      { requestId: '1', reason: 'no turn started for it' },
    ])
  })
})

describe('TurnLedger: an API error (StopFailure) ends the turn\'s prompt at once, in both modes', () => {
  const GRACE = 1000
  const billing: FailureRecord = { atMs: 500, error: 'billing_error', errorDetails: 'Your credit balance is too low.' }

  test('the error frame names the error, with its details when the hook kept them', () => {
    expect(turnFailedDescription({ error: 'billing_error', errorDetails: 'Your credit balance is too low.' })).toBe(
      'the turn failed on a model API error: billing_error (Your credit balance is too low.)',
    )
    expect(turnFailedDescription({ error: 'rate_limit' })).toBe('the turn failed on a model API error: rate_limit')
    expect(turnFailedDescription({})).toBe('the turn failed on a model API error: unknown')
  })

  test('by prompt id: the prompt bound to the failed turn ends at once, with the error, never with a final text', () => {
    const turns = ledger()
    turns.startBinding()
    turns.delivered('1', view(idleStop(100)), 200)
    turns.bind('1', 'pF')
    turns.observeFailure({ ...billing, promptId: 'pF' })
    turns.turnEnded('pF', { kind: 'failure', failure: { error: 'billing_error', errorDetails: 'Your credit balance is too low.' } })
    const ended = turns.unanswered(view(idleStop(100)), 501, GRACE)
    expect(ended).toEqual([
      {
        requestId: '1',
        reason: 'its turn failed',
        failure: { error: 'billing_error', errorDetails: 'Your credit balance is too low.' },
      },
    ])
    expect(ended[0]!.finalText).toBeUndefined()
  })

  test('the fallback: the owner ends at once; another open prompt by the grace rule, the failure counting as its Stop', () => {
    const finished = new Set<string>()
    const turns = ledger(finished)
    // '1' owns the turn; '2' arrives while it runs.
    expect(turns.delivered('1', view(idleStop(100)), 200)).toBe(true)
    expect(turns.delivered('2', view(idleStop(100), call('p1', 300)), 400)).toBe(false)
    // Claude Code fires StopFailure, never Stop: `.stop` still holds the old Stop.
    turns.observeFailure(billing)
    const stopped = view(idleStop(100), call('p1', 300))
    expect(turns.unanswered(stopped, 501, GRACE)).toEqual([
      { requestId: '1', reason: 'its turn failed', failure: { error: 'billing_error', errorDetails: 'Your credit balance is too low.' } },
    ])
    finished.add('1')
    expect(turns.unanswered(stopped, 500 + GRACE - 1, GRACE)).toEqual([])
    expect(turns.unanswered(stopped, 500 + GRACE, GRACE)).toEqual([{ requestId: '2', reason: 'no turn started for it' }])
    // The owner is no longer owning: the Stop hook refuses nothing for it.
    expect(turns.owning()).toEqual([])
  })
})

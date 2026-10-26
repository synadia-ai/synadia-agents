// Claude Code's turns by their prompt ids: the two modes, and the rules
// the tracker follows in binding mode, with the sequences measured on
// Claude Code 2.1.310.

import { describe, expect, test } from 'bun:test'
import type { FailureRecord, StopRecord, SubmitRecord, TurnActivity } from '../src/session-id.js'
import { TurnTracker, type TurnTrackerStart } from '../src/turns.js'

const SESSION = '0b7e1c9a-2f4d-4e1b-9c3a-5d6e7f8a9b0c'
const CHANNEL = 'plugin:nats-channel:nats'

const typed = (promptId: string | undefined, atMs: number): SubmitRecord => ({
  sessionId: SESSION,
  ...(promptId !== undefined ? { promptId } : {}),
  atMs,
})
const channel = (promptId: string, requestId: string, atMs: number): SubmitRecord => ({
  sessionId: SESSION,
  promptId,
  requestId,
  source: CHANNEL,
  atMs,
})
const call = (promptId: string | undefined, atMs: number): TurnActivity => ({
  ...(promptId !== undefined ? { promptId } : {}),
  firstMs: atMs,
  atMs,
})
const stop = (promptId: string | undefined, atMs: number): StopRecord => ({
  sessionId: SESSION,
  ...(promptId !== undefined ? { promptId } : {}),
  background: false,
  atMs,
})
const failure = (promptId: string, atMs: number): FailureRecord => ({ sessionId: SESSION, promptId, atMs })

/** A tracker whose hooks write one line per call, and the set of open requests. */
function tracked(start: TurnTrackerStart = {}, open: Set<string> = new Set()) {
  const calls: string[] = []
  const tracker = new TurnTracker(
    {
      isOpen: (id) => open.has(id),
      currentSession: () => 'current-session',
      bindingStarted: () => calls.push('binding'),
      promptStarted: (id, turn, at, session) =>
        calls.push(`started ${id} in ${turn.promptId} (${turn.kind}) at ${at} ${session ?? '-'}`),
      localTurnStarted: (turn, at) => calls.push(`local ${turn.id} at ${at} ${turn.sessionId ?? '-'}`),
      localTurnEnded: (turn, outcome, at) => calls.push(`local ${turn.id} ended ${outcome} at ${at}`),
      promptRebound: (id, promptId) => calls.push(`rebound ${id} to ${promptId}`),
      turnEnded: (turn, end) =>
        calls.push(
          `ended ${turn.promptId} (${turn.kind}) [${turn.requests.join(',')}] by ${end.kind} at ${end.kind === 'stop' ? end.stop.atMs : end.atMs}`,
        ),
    },
    start,
  )
  return { tracker, calls, open }
}

describe('fallback mode: before the first submit with a prompt id, nothing is followed', () => {
  test('a tool call with a prompt id, a Stop and a failure open no local turn', () => {
    const { tracker, calls } = tracked()
    tracker.activity(call('p1', 10))
    tracker.stopped(stop('p1', 20))
    tracker.failed(failure('p2', 30))
    expect(calls).toEqual([])
    expect(tracker.binding()).toBe(false)
    expect(tracker.current()).toBeUndefined()
  })

  test('a submit without a prompt id does not begin binding mode', () => {
    const { tracker, calls } = tracked()
    tracker.submitted(typed(undefined, 10))
    tracker.submitted({ requestId: '1', source: CHANNEL, atMs: 11 })
    expect(calls).toEqual([])
    expect(tracker.binding()).toBe(false)
  })

  test('the first submit with a prompt id begins binding mode, and counts', () => {
    const { tracker, calls } = tracked()
    tracker.submitted(typed('p1', 10))
    expect(tracker.binding()).toBe(true)
    expect(calls).toEqual(['binding', `local local-p1 at 10 ${SESSION}`])
  })
})

describe('the start after a restart', () => {
  test('a log that already holds a submit: binding mode at once, and the last Stop begins the turn running now', () => {
    const { tracker, calls } = tracked({ binding: true, lastStopMs: 100 })
    expect(tracker.binding()).toBe(true)
    // A turn that began before this server: first seen by a tool call.
    tracker.activity(call('p9', 400))
    tracker.stopped(stop('p9', 500))
    expect(calls).toEqual([
      'local local-p9 at 100 current-session',
      'ended p9 (local) [] by stop at 500',
      'local local-p9 ended ok at 500',
    ])
  })

  test('without a submit in the log, the start is fallback mode', () => {
    const { tracker, calls } = tracked({ binding: false, lastStopMs: 100 })
    tracker.activity(call('p9', 400))
    expect(calls).toEqual([])
  })
})

describe('rule 2: typed text', () => {
  test('typed when idle is a local turn from its submit to its Stop', () => {
    const { tracker, calls } = tracked({ binding: true })
    tracker.submitted(typed('pA', 10))
    tracker.activity(call('pA', 12))
    expect(tracker.current()).toMatchObject({ promptId: 'pA', kind: 'local', startedAtMs: 10, sessionId: SESSION })
    tracker.stopped(stop('pA', 40))
    expect(calls).toEqual([
      `local local-pA at 10 ${SESSION}`,
      'ended pA (local) [] by stop at 40',
      'local local-pA ended ok at 40',
    ])
    expect(tracker.current()).toBeUndefined()
    expect(tracker.turn('pA')).toMatchObject({ promptId: 'pA', kind: 'local' })
  })

  test('typed while a turn runs carries the running id: nothing', () => {
    const { tracker, calls } = tracked({ binding: true })
    tracker.submitted(typed('pN', 10))
    tracker.submitted(typed('pN', 15))
    expect(calls).toEqual([`local local-pN at 10 ${SESSION}`])
  })

  test('an interrupt: a new id without a Stop ends the turn at the next submit', () => {
    const { tracker, calls } = tracked({ binding: true })
    tracker.submitted(typed('pX', 10))
    tracker.activity(call('pX', 12))
    // Esc: no Stop. The next typed turn has a new id.
    tracker.submitted(typed('pY', 70))
    expect(calls).toEqual([
      `local local-pX at 10 ${SESSION}`,
      'ended pX (local) [] by next at 70',
      'local local-pX ended ok at 70',
      `local local-pY at 70 ${SESSION}`,
    ])
  })
})

describe('rule 1: a channel message', () => {
  test('taken when idle: a served turn, the request started at the submit, with its session', () => {
    const { tracker, calls } = tracked({ binding: true }, new Set(['1']))
    tracker.submitted(channel('pC', '1', 10))
    tracker.activity(call('pC', 12))
    tracker.stopped(stop('pC', 30))
    expect(calls).toEqual([
      `started 1 in pC (served) at 10 ${SESSION}`,
      'ended pC (served) [1] by stop at 30',
    ])
    expect(tracker.boundTo('1')).toBe('pC')
  })

  test('a fold: the channel submit carries the running typed turn\'s id, and the request joins it there', () => {
    // timeline-3 :48-62: typed 0dded3ad, sleep 20, the channel prompt's submit with 0dded3ad.
    const { tracker, calls } = tracked({ binding: true }, new Set(['1']))
    tracker.submitted(typed('0dded3ad', 100))
    tracker.activity(call('0dded3ad', 150))
    tracker.submitted(channel('0dded3ad', '1', 20_900))
    tracker.activity(call('0dded3ad', 20_950))
    tracker.stopped(stop('0dded3ad', 21_000))
    expect(calls).toEqual([
      `local local-0dded3ad at 100 ${SESSION}`,
      `started 1 in 0dded3ad (local) at 20900 ${SESSION}`,
      'ended 0dded3ad (local) [1] by stop at 21000',
      'local local-0dded3ad ended ok at 21000',
    ])
  })

  test('two prompts folded into one turn: both bound, in the order they started', () => {
    const { tracker } = tracked({ binding: true }, new Set(['1', '2']))
    tracker.submitted(channel('pS', '1', 10))
    tracker.submitted(channel('pS', '2', 20))
    expect(tracker.current()?.requests).toEqual(['1', '2'])
  })

  test('the measured run-3 sequence: a prompt queued behind a typed turn starts its own turn after the Stop', () => {
    // TYPED-L SLOW10, then NATS-M delivered during it; no tool result, so
    // no fold: the typed turn stops, then the channel prompt's turn begins.
    const { tracker, calls, open } = tracked({ binding: true })
    tracker.submitted(typed('56394d0f', 1_000))
    open.add('2')
    tracker.stopped(stop('56394d0f', 10_000))
    tracker.submitted(channel('f04c8ad3', '2', 10_031))
    tracker.activity(call('f04c8ad3', 10_063))
    tracker.stopped(stop('f04c8ad3', 10_100))
    expect(calls).toEqual([
      `local local-56394d0f at 1000 ${SESSION}`,
      'ended 56394d0f (local) [] by stop at 10000',
      'local local-56394d0f ended ok at 10000',
      `started 2 in f04c8ad3 (served) at 10031 ${SESSION}`,
      'ended f04c8ad3 (served) [2] by stop at 10100',
    ])
  })

  test('a channel submit while a local turn runs under another id ends it first, at the submit', () => {
    const { tracker, calls } = tracked({ binding: true }, new Set(['3']))
    tracker.submitted(typed('pL', 10))
    tracker.submitted(channel('pM', '3', 50))
    expect(calls).toEqual([
      `local local-pL at 10 ${SESSION}`,
      'ended pL (local) [] by next at 50',
      'local local-pL ended ok at 50',
      `started 3 in pM (served) at 50 ${SESSION}`,
    ])
  })

  test('a request no longer open when Claude Code takes it: a served turn bound to nothing, no local turn', () => {
    const { tracker, calls } = tracked({ binding: true })
    tracker.submitted(typed('pL', 10))
    tracker.stopped(stop('pL', 20))
    // Cancelled while it waited.
    tracker.submitted(channel('pZ', '4', 30))
    tracker.activity(call('pZ', 35))
    tracker.stopped(stop('pZ', 40))
    expect(calls.slice(3)).toEqual(['ended pZ (served) [] by stop at 40'])
    expect(tracker.boundTo('4')).toBeUndefined()
  })

  test('a request already started is not started again', () => {
    const { tracker, calls } = tracked({ binding: true }, new Set(['5']))
    tracker.submitted(channel('pA', '5', 10))
    tracker.submitted(channel('pA', '5', 11))
    expect(calls).toEqual([`started 5 in pA (served) at 10 ${SESSION}`])
  })

  test('the session comes from the submit, else the current one', () => {
    const { tracker, calls } = tracked({ binding: true }, new Set(['6']))
    tracker.submitted({ promptId: 'pA', requestId: '6', source: CHANNEL, atMs: 10 })
    expect(calls).toEqual(['started 6 in pA (served) at 10 current-session'])
  })
})

describe('rule 3: a turn no submit announced', () => {
  test('waiting typed text that becomes its own turn: begun at the last Stop', () => {
    // TYPED-P SLOW10, TYPED-Q typed while it runs (with the running id);
    // two Stops 64 ms apart, the second with an id no submit announced.
    const { tracker, calls } = tracked({ binding: true })
    tracker.submitted(typed('6220a92d', 1_000))
    tracker.submitted(typed('6220a92d', 4_000))
    tracker.stopped(stop('6220a92d', 11_000))
    tracker.stopped(stop('679a3897', 11_064))
    expect(calls).toEqual([
      `local local-6220a92d at 1000 ${SESSION}`,
      'ended 6220a92d (local) [] by stop at 11000',
      'local local-6220a92d ended ok at 11000',
      `local local-679a3897 at 11000 ${SESSION}`,
      'ended 679a3897 (local) [] by stop at 11064',
      'local local-679a3897 ended ok at 11064',
    ])
  })

  test('first seen by a tool call: begun at the last Stop, the session the current one', () => {
    const { tracker, calls } = tracked({ binding: true })
    tracker.submitted(typed('pV', 1_000))
    tracker.stopped(stop('pV', 2_000))
    tracker.activity(call('pW', 2_050))
    expect(calls.slice(3)).toEqual(['local local-pW at 2000 current-session'])
  })

  test('with no Stop since the current turn began: begun at the record, the current turn ending there', () => {
    const { tracker, calls } = tracked({ binding: true })
    tracker.submitted(typed('pX', 1_000))
    // An interrupt, then waiting text runs as its own turn: no Stop of pX.
    tracker.activity(call('pY', 5_000))
    tracker.stopped(stop('pY', 6_000))
    expect(calls).toEqual([
      `local local-pX at 1000 ${SESSION}`,
      'ended pX (local) [] by next at 5000',
      'local local-pX ended ok at 5000',
      'local local-pY at 5000 current-session',
      'ended pY (local) [] by stop at 6000',
      'local local-pY ended ok at 6000',
    ])
  })

  test('a Stop that is the turn\'s only record ends the turn it begins', () => {
    const { tracker, calls } = tracked({ binding: true })
    tracker.submitted(typed('pX', 1_000))
    tracker.stopped(stop('pY', 3_000))
    expect(calls.slice(-2)).toEqual(['ended pY (local) [] by stop at 3000', 'local local-pY ended ok at 3000'])
    expect(tracker.current()).toBeUndefined()
  })
})

describe('rule 4: ends', () => {
  test('a failure ends the turn with an error, and the next unannounced turn begins there', () => {
    const { tracker, calls } = tracked({ binding: true }, new Set(['1']))
    tracker.submitted(channel('pF', '1', 10))
    tracker.failed(failure('pF', 500))
    tracker.activity(call('pG', 600))
    expect(calls).toEqual([
      `started 1 in pF (served) at 10 ${SESSION}`,
      'ended pF (served) [1] by failure at 500',
      'local local-pG at 500 current-session',
    ])
    const local = tracked({ binding: true })
    local.tracker.submitted(typed('pH', 10))
    local.tracker.failed(failure('pH', 20))
    expect(local.calls.slice(-1)).toEqual(['local local-pH ended error at 20'])
  })

  test('the records of a turn already ended are ignored', () => {
    const { tracker, calls } = tracked({ binding: true })
    tracker.submitted(typed('pA', 10))
    tracker.stopped(stop('pA', 20))
    const before = calls.length
    tracker.activity(call('pA', 30))
    tracker.stopped(stop('pA', 40))
    tracker.submitted(typed('pA', 50))
    tracker.failed(failure('pA', 60))
    expect(calls.length).toBe(before)
    expect(tracker.current()).toBeUndefined()
  })

  test('a Stop no later than the turn\'s start never ends it', () => {
    const { tracker, calls } = tracked({ binding: true })
    tracker.submitted(typed('pA', 100))
    tracker.stopped(stop('pA', 100))
    tracker.stopped(stop('pA', 90))
    expect(tracker.current()?.promptId).toBe('pA')
    expect(calls).toEqual([`local local-pA at 100 ${SESSION}`])
  })

  test('a Stop without a prompt id ends nothing', () => {
    const { tracker } = tracked({ binding: true })
    tracker.submitted(typed('pA', 10))
    tracker.stopped(stop(undefined, 20))
    expect(tracker.current()?.promptId).toBe('pA')
  })
})

describe('rule 5: shutdown', () => {
  test('the open turn ends now; nothing after', () => {
    const { tracker, calls } = tracked({ binding: true })
    tracker.submitted(typed('pA', 10))
    tracker.shutdown(99)
    tracker.shutdown(100)
    expect(calls).toEqual([
      `local local-pA at 10 ${SESSION}`,
      'ended pA (local) [] by shutdown at 99',
      'local local-pA ended ok at 99',
    ])
  })
})

describe('the turns a call names', () => {
  test('turn() names the current turn and the ended ones; boundTo the request\'s turn until forgotten', () => {
    const { tracker } = tracked({ binding: true }, new Set(['1']))
    tracker.submitted(channel('pA', '1', 10))
    tracker.stopped(stop('pA', 20))
    tracker.submitted(typed('pB', 30))
    expect(tracker.turn('pA')).toMatchObject({ kind: 'served', requests: ['1'] })
    expect(tracker.turn('pB')).toMatchObject({ kind: 'local', local: { id: 'local-pB', local: true } })
    expect(tracker.turn('pZ')).toBeUndefined()
    expect(tracker.boundTo('1')).toBe('pA')
    tracker.forget('1')
    expect(tracker.boundTo('1')).toBeUndefined()
  })
})

describe('a channel message of an earlier server', () => {
  test('sent before this server started, it binds none of this server\'s requests of the same id', () => {
    // The server restarted at 1000; Claude Code still had the old server's
    // request "1" queued, and this server has handed out a "1" of its own.
    const { tracker, calls } = tracked({ binding: true, sinceMs: 1_000 }, new Set(['1']))
    tracker.submitted({ ...channel('pOld', '1', 1_200), sentAtMs: 900 })
    tracker.stopped(stop('pOld', 1_300))
    expect(calls).toEqual(['ended pOld (served) [] by stop at 1300'])
    expect(tracker.boundTo('1')).toBeUndefined()
    // This server's own message "1" binds it when Claude Code takes it.
    tracker.submitted({ ...channel('pNew', '1', 1_400), sentAtMs: 1_100 })
    expect(calls.slice(1)).toEqual([`started 1 in pNew (served) at 1400 ${SESSION}`])
    expect(tracker.boundTo('1')).toBe('pNew')
  })

  test('without the start time or the message\'s, the request binds as before', () => {
    const { tracker } = tracked({ binding: true }, new Set(['1']))
    tracker.submitted({ ...channel('pA', '1', 1_200), sentAtMs: 900 })
    expect(tracker.boundTo('1')).toBe('pA')
    const other = tracked({ binding: true, sinceMs: 1_000 }, new Set(['1']))
    other.tracker.submitted(channel('pB', '1', 1_200))
    expect(other.tracker.boundTo('1')).toBe('pB')
  })
})

describe('rule 6: channel messages taken together', () => {
  test('the measured sequence: three messages queued behind a typed turn run as one turn under the last id', () => {
    // 2026-10-26: three submits 20 ms apart, each its own prompt id; every
    // reply and the Stop carry the last one, 4686cac0.
    const { tracker, calls } = tracked({ binding: true }, new Set(['1', '2', '3']))
    tracker.submitted(typed('e2bb8c16', 0))
    tracker.stopped(stop('e2bb8c16', 10_088))
    calls.length = 0
    tracker.submitted(channel('6da547e5', '1', 10_128))
    tracker.submitted(channel('d6014bb9', '2', 10_149))
    tracker.submitted(channel('4686cac0', '3', 10_168))
    tracker.activity(call('4686cac0', 10_205))
    tracker.stopped(stop('4686cac0', 10_332))
    expect(calls).toEqual([
      `started 1 in 6da547e5 (served) at 10128 ${SESSION}`,
      'rebound 1 to d6014bb9',
      `started 2 in d6014bb9 (served) at 10149 ${SESSION}`,
      'rebound 1 to 4686cac0',
      'rebound 2 to 4686cac0',
      `started 3 in 4686cac0 (served) at 10168 ${SESSION}`,
      'ended 4686cac0 (served) [1,2,3] by stop at 10332',
    ])
    expect(tracker.boundTo('1')).toBe('4686cac0')
    // The earlier ids name the same turn.
    expect(tracker.turn('6da547e5')?.promptId).toBe('4686cac0')
    expect(tracker.turn('d6014bb9')?.requests).toEqual(['1', '2', '3'])
  })

  test('the gap is the hooks\' time, not the signal: 1.2 s apart (a slow hook of the user\'s), still one turn', () => {
    const { tracker, calls } = tracked({ binding: true }, new Set(['1', '2']))
    tracker.submitted(channel('pA', '1', 100))
    tracker.submitted(channel('pB', '2', 1_300))
    tracker.stopped(stop('pB', 1_400))
    expect(calls).toEqual([
      `started 1 in pA (served) at 100 ${SESSION}`,
      'rebound 1 to pB',
      `started 2 in pB (served) at 1300 ${SESSION}`,
      'ended pB (served) [1,2] by stop at 1400',
    ])
  })

  test('not after the turn ran a tool, not past the bound, not after typed text: the next turn, as before', () => {
    const ran = tracked({ binding: true }, new Set(['1', '2']))
    ran.tracker.submitted(channel('pA', '1', 100))
    ran.tracker.activity(call('pA', 130))
    ran.tracker.submitted(channel('pB', '2', 150))
    expect(ran.calls).toContain('ended pA (served) [1] by next at 150')
    // Past the bound, which stands in for a lost Stop line.
    const late = tracked({ binding: true }, new Set(['1', '2']))
    late.tracker.submitted(channel('pA', '1', 100))
    late.tracker.submitted(channel('pB', '2', 30_101))
    expect(late.calls).toContain('ended pA (served) [1] by next at 30101')
    // A Stop of the first between the two: two turns.
    const stopped = tracked({ binding: true }, new Set(['1', '2']))
    stopped.tracker.submitted(channel('pA', '1', 100))
    stopped.tracker.stopped(stop('pA', 110))
    stopped.tracker.submitted(channel('pB', '2', 120))
    expect(stopped.calls).toEqual([
      `started 1 in pA (served) at 100 ${SESSION}`,
      'ended pA (served) [1] by stop at 110',
      `started 2 in pB (served) at 120 ${SESSION}`,
    ])
    const typedFirst = tracked({ binding: true }, new Set(['1']))
    typedFirst.tracker.submitted(channel('pA', '1', 100))
    typedFirst.tracker.submitted(typed('pT', 120))
    expect(typedFirst.calls).toContain('ended pA (served) [1] by next at 120')
    // A local turn takes no channel message by rule 6: a new id is a new turn.
    const local = tracked({ binding: true }, new Set(['1']))
    local.tracker.submitted(typed('pT', 100))
    local.tracker.submitted(channel('pC', '1', 110))
    expect(local.calls).toContain('ended pT (local) [] by next at 110')
  })
})

describe('rule 6: what breaks a batch, as the Stop hook reads it', () => {
  test('typed text under the running turn\'s id, a submit without a prompt id, or a Stop without one, between two channel submits', () => {
    const between: Array<[string, (t: TurnTracker) => void]> = [
      ['typed', (t) => t.submitted(typed('pA', 110))],
      ['no prompt id', (t) => t.submitted(typed(undefined, 110))],
      ['a Stop without a prompt id', (t) => t.stopped(stop(undefined, 110))],
    ]
    for (const [what, line] of between) {
      const { tracker, calls } = tracked({ binding: true }, new Set(['1', '2']))
      tracker.submitted(channel('pA', '1', 100))
      line(tracker)
      tracker.submitted(channel('pB', '2', 120))
      expect([what, calls]).toEqual([
        what,
        [
          `started 1 in pA (served) at 100 ${SESSION}`,
          'ended pA (served) [1] by next at 120',
          `started 2 in pB (served) at 120 ${SESSION}`,
        ],
      ])
    }
  })
})

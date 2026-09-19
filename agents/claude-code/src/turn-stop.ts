import { hooksActive, readTurnStop, type SessionIdSource } from './session-id.js'

/**
 * When a prompt's turn really ends.
 *
 * The reply tool completes the request for the caller, but Claude Code's
 * turn goes on: after the tool result it makes at least one more model
 * call to write its closing text. A served window closed at the reply
 * would leave that call outside it. So the `end` record waits for the
 * Stop hook, which Claude Code fires when the turn is over, and takes
 * its timestamp.
 *
 * Bounded and optional: without the hooks (no SessionStart file for
 * this Claude Code process) the turn ends at the reply; with them, a
 * Stop that never comes — the hook failed, or Claude Code kept working
 * for longer than the limit — ends it at the limit, so a record is
 * never owed forever.
 */

/** Longest a settled prompt waits for the Stop hook. */
export const STOP_WAIT_MS = 120_000
const POLL_MS = 250

export interface TurnStopWaiter {
  /**
   * Resolves with the turn end in unix seconds as the hook recorded it,
   * or `undefined` when the reply itself is the turn end: hooks inactive,
   * the wait cancelled, or the limit reached. Never rejects.
   */
  wait(): Promise<number | undefined>
  /** Stop waiting now (shutdown); `wait` resolves `undefined`. */
  cancel(): void
}

/**
 * A waiter for the first Stop the hook records after `afterMs` (epoch
 * milliseconds — when the reply completed the request). A Stop from an
 * earlier turn is older than that and ignored. Both times come from the
 * same clock: the hook writes `Date.now()`, the server compares with it.
 */
export function turnStopWaiter(
  source: SessionIdSource,
  afterMs: number,
  limitMs: number = STOP_WAIT_MS,
  pollMs: number = POLL_MS,
): TurnStopWaiter {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let finish: (() => void) | undefined
  const cancel = (): void => {
    cancelled = true
    if (timer !== undefined) clearTimeout(timer)
    finish?.()
  }
  const wait = async (): Promise<number | undefined> => {
    if (!hooksActive(source)) return undefined
    const deadline = afterMs + limitMs
    while (!cancelled) {
      const stoppedAtMs = readTurnStop(source)
      if (stoppedAtMs !== undefined && stoppedAtMs > afterMs) return Math.floor(stoppedAtMs / 1000)
      if (Date.now() >= deadline) return undefined
      await new Promise<void>(resolve => {
        finish = resolve
        timer = setTimeout(resolve, pollMs)
        timer.unref?.()
      })
      finish = undefined
    }
    return undefined
  }
  return { wait, cancel }
}

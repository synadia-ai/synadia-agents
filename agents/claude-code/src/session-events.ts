import {
  readSessionRecord,
  readTurnStop,
  type SessionIdSource,
  type SessionRecord,
  type StopRecord,
} from './session-id.js'

/**
 * How the server learns of the hooks' SessionStart and Stop: a bounded
 * poll of the two files the hooks write for this Claude Code process
 * (`src/session-id.ts`). Two small reads every {@link SESSION_POLL_MS}; a
 * directory watch would save them but behaves differently per platform,
 * and a Stop is never needed sooner than a quarter second after it ran.
 *
 * A record is new when its `at_ms` differs from the last one seen. At
 * start, a session already recorded is reported once (the hook ran before
 * the server came up, as it does at `startup`), and a Stop already
 * recorded is not: it belongs to a turn that ended before this server.
 */

export const SESSION_POLL_MS = 250

export interface SessionEventHandlers {
  sessionStarted(sessionId: string, source: string): void
  turnStopped(sessionId: string | undefined, atMs: number): void
}

export interface SessionEventWatcher {
  /** Read the files now and report what changed; the timer calls this. */
  poll(): void
  /** Stop polling. Idempotent. */
  stop(): void
}

export function watchSessionEvents(
  source: SessionIdSource,
  handlers: SessionEventHandlers,
  intervalMs: number = SESSION_POLL_MS,
): SessionEventWatcher {
  let session: SessionRecord | undefined
  let stop: StopRecord | undefined = readTurnStop(source)

  const poll = (): void => {
    const nextSession = readSessionRecord(source)
    if (nextSession && nextSession.atMs !== session?.atMs) {
      session = nextSession
      handlers.sessionStarted(nextSession.sessionId, nextSession.source)
    }
    const nextStop = readTurnStop(source)
    if (nextStop && nextStop.atMs !== stop?.atMs) {
      stop = nextStop
      handlers.turnStopped(nextStop.sessionId ?? session?.sessionId, nextStop.atMs)
    }
  }

  poll()
  const timer = setInterval(poll, intervalMs)
  timer.unref?.()
  return {
    poll,
    stop: () => clearInterval(timer),
  }
}

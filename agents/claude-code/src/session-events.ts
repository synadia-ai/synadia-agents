import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import {
  eventsFilePath,
  parseEventLine,
  readSessionRecord,
  readTurnActivity,
  type FailureRecord,
  type SessionIdSource,
  type SessionRecord,
  type StopRecord,
  type SubmitRecord,
  type TurnActivity,
} from './session-id.js'

/**
 * How the server learns of the hooks' events: a bounded poll of the files
 * the hooks write for this Claude Code process (`src/session-id.ts`) every
 * {@link SESSION_POLL_MS}; a directory watch would save the reads but
 * behaves differently per platform.
 *
 *   - `<pid>`, SessionStart: reported when its `at_ms` changes;
 *   - `<pid>.events`, the submitted prompts, the recorded Stops and the
 *     StopFailures: read from where the last poll left off, whole lines
 *     only (a last line without its newline waits for the next poll), each
 *     line reported once;
 *   - `<pid>.turn`, the latest tool call: reported when its `at_ms` changes.
 *
 * One poll's records are handed over in the order of their `at_ms`, across
 * the files. `.turn` holds one record, so two tool calls within one poll
 * are one report; the events log loses nothing, which is why the turns are
 * followed by it.
 *
 * At start, a session already recorded is reported once (the hook ran
 * before the server came up, as it does at `startup`), and what the log and
 * `.turn` already held at the mark is not: it belongs to turns that ran
 * before this server. The mark ({@link markSessionEvents}) is taken when
 * the watcher is made, or earlier by the server, before it can take a
 * prompt, so a prompt Claude Code takes before the watcher polls is still
 * reported.
 */

export const SESSION_POLL_MS = 250

export interface SessionEventHandlers {
  sessionStarted(sessionId: string, source: string): void
  turnStopped(sessionId: string | undefined, stop: StopRecord): void
  /** A prompt Claude Code took into a turn: typed, a command, a channel message. */
  promptSubmitted?(submit: SubmitRecord): void
  /** A turn an API error ended. */
  turnFailed?(failure: FailureRecord): void
  /** A tool call: the latest one since the last poll. */
  turnActivity?(activity: TurnActivity): void
}

/** Where a watcher starts reading: what the files held then is not reported. */
export interface SessionEventsMark {
  /** Where the complete lines of the events log ended. */
  readonly offset: number
  /** The tool call `.turn` held. */
  readonly activity: TurnActivity | undefined
}

export interface SessionEventWatcher {
  /** Read the files now and report what changed; the timer calls this. */
  poll(): void
  /** Stop polling. Idempotent. */
  stop(): void
}

/** Where the complete lines of the file at `path` end, from `offset`, and what they hold. */
function readCompleteLines(path: string, offset: number): { lines: string[]; next: number } {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    // No log yet, or it was removed: a new one is read from its start.
    return { lines: [], next: 0 }
  }
  try {
    const size = fstatSync(fd).size
    // Shorter than what was read: replaced, so read it from its start.
    const from = size < offset ? 0 : offset
    if (size === from) return { lines: [], next: from }
    const buffer = Buffer.alloc(size - from)
    const read = readSync(fd, buffer, 0, buffer.length, from)
    const end = buffer.subarray(0, read).lastIndexOf(0x0a)
    if (end < 0) return { lines: [], next: from }
    const lines = buffer
      .subarray(0, end + 1)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    return { lines, next: from + end + 1 }
  } catch {
    return { lines: [], next: offset }
  } finally {
    closeSync(fd)
  }
}

/** The files as they stand now: a watcher made `from` this reports what comes after. */
export function markSessionEvents(source: SessionIdSource): SessionEventsMark {
  return {
    offset: readCompleteLines(eventsFilePath(source.stateDir, source.parentPid), 0).next,
    activity: readTurnActivity(source),
  }
}

export function watchSessionEvents(
  source: SessionIdSource,
  handlers: SessionEventHandlers,
  intervalMs: number = SESSION_POLL_MS,
  from: SessionEventsMark = markSessionEvents(source),
): SessionEventWatcher {
  const eventsPath = eventsFilePath(source.stateDir, source.parentPid)
  let session: SessionRecord | undefined
  // What the log and `.turn` held at the mark is not reported.
  let offset = from.offset
  let activity: TurnActivity | undefined = from.activity

  let polling = false
  const poll = (): void => {
    // A handler that polls again finds this poll under way: it reports
    // nothing twice and nothing out of order.
    if (polling) return
    polling = true
    try {
      pollOnce()
    } finally {
      polling = false
    }
  }

  const pollOnce = (): void => {
    // Each record with its time, in the order read; sorted by time below.
    const due: Array<{ readonly atMs: number; readonly report: () => void }> = []

    const nextSession = readSessionRecord(source)
    if (nextSession && nextSession.atMs !== session?.atMs) {
      due.push({
        atMs: nextSession.atMs,
        report: () => {
          session = nextSession
          handlers.sessionStarted(nextSession.sessionId, nextSession.source)
        },
      })
    }

    const read = readCompleteLines(eventsPath, offset)
    offset = read.next
    for (const line of read.lines) {
      const event = parseEventLine(line)
      if (event === undefined) continue
      switch (event.kind) {
        case 'submit':
          due.push({ atMs: event.submit.atMs, report: () => handlers.promptSubmitted?.(event.submit) })
          break
        case 'stop':
          due.push({
            atMs: event.stop.atMs,
            report: () => handlers.turnStopped(event.stop.sessionId ?? session?.sessionId, event.stop),
          })
          break
        case 'failure':
          due.push({ atMs: event.failure.atMs, report: () => handlers.turnFailed?.(event.failure) })
          break
      }
    }

    const nextActivity = readTurnActivity(source)
    if (nextActivity && nextActivity.atMs !== activity?.atMs) {
      activity = nextActivity
      due.push({ atMs: nextActivity.atMs, report: () => handlers.turnActivity?.(nextActivity) })
    }

    // Stable: records of one time keep the order read.
    due.sort((a, b) => a.atMs - b.atMs)
    for (const item of due) item.report()
  }

  poll()
  const timer = setInterval(poll, intervalMs)
  timer.unref?.()
  return {
    poll,
    stop: () => clearInterval(timer),
  }
}

import type { LocalTurn, Outcome } from './extensions.js'
import type { FailureRecord, StopRecord, SubmitRecord, TurnActivity } from './session-id.js'

/**
 * Claude Code's turns, followed by their prompt ids.
 *
 * What Claude Code 2.1.310 was measured to do:
 *
 *   - typed text and channel messages wait in one first-in, first-out
 *     queue; a waiting input is folded into the running turn at its next
 *     tool result, and with no further tool result it starts the next turn
 *     after the Stop;
 *   - a turn is one `prompt_id`, on every PreToolUse, Stop and StopFailure,
 *     and the same through a fold;
 *   - UserPromptSubmit fires for a channel message when Claude Code takes
 *     it (at the fold, or at the start of its own turn), carrying the id of
 *     the turn it runs in; for typed text it fires at submit, with the
 *     running turn's id when Claude Code is busy, and when that text later
 *     becomes a turn of its own nothing announces it: its id first shows on
 *     PreToolUse and Stop;
 *   - an interrupt (Esc) gives no Stop; the next turn has a new id.
 *
 * So a turn is a prompt id, and one of two kinds: **served**, the turn a
 * channel message started (its submit carried a new id); or **local**, any
 * other turn — typed when idle, typed text that waited and became its own
 * turn, a turn Claude Code began itself (a background task's report, a
 * session cron), a custom command, a message from another session. A
 * served request is bound to the prompt id its channel submit carried: its
 * own turn's, or, folded, the running turn's. That binding, not the time
 * the channel handed the request over, says which turn a request lives in.
 *
 * The server feeds the tracker the hooks' records in the order of their
 * times (`src/session-events.ts`). Two modes:
 *
 *   - **binding**, from the first submit record with a prompt id this
 *     process sees (or one already in the log at start, so a restart during
 *     a typed turn does not fall back);
 *   - **fallback** before that: nothing is followed, no local turn is
 *     reported, and the served prompts keep the rules of a Claude Code that
 *     reports no submits (`src/permission-routing.ts`). A Claude Code that
 *     does not run the hook, or gives no prompt ids, never leaves it.
 *
 * The rules, in binding mode:
 *
 *   1. a channel submit with prompt id P: when its request is no longer
 *      open (or already started), or the message was sent before this
 *      server started (an earlier server's request of the same id), the turn
 *      is a served turn bound to no request; else, P being the current
 *      turn's, the request joins it (a fold), and otherwise a new served
 *      turn P begins, the current one ending first at the same time.
 *      Either way the request starts now;
 *   2. a typed submit with prompt id P: nothing when P is the current
 *      turn's (the text joins it, or waits and surfaces by rule 3); else a
 *      new local turn P begins, the current one ending first at the same
 *      time (an interrupt);
 *   3. a tool call, a Stop or a failure with a prompt id P no submit
 *      announced and not the current turn's: a new local turn P, begun at
 *      the last Stop or failure when one came after the current turn began
 *      (waiting text starts right after that Stop), else at the record's
 *      time; the current turn, if still open, ends then;
 *   4. a Stop of P ends turn P, a failure of P ends it with an error; the
 *      records of a turn already ended are ignored, and a record no later
 *      than the current turn's start never ends it, unless rule 3 began the
 *      turn for that very record;
 *   5. at shutdown the current turn ends now.
 *
 * Records without a prompt id do nothing.
 */

/** One turn of Claude Code's, as the tracker follows it. */
export interface Turn {
  /** Claude Code's prompt id: one per turn, the same through a fold. */
  readonly promptId: string
  /** `served`: a channel message started it; `local`: anything else. */
  readonly kind: 'served' | 'local'
  readonly startedAtMs: number
  /** The session the turn runs in, when known. */
  readonly sessionId?: string
  /** The requests bound to it, in the order they started. */
  readonly requests: readonly string[]
  /** A local turn as the extensions' events name it. */
  readonly local?: LocalTurn
}

/** How a turn ended. */
export type TurnEnd =
  | { readonly kind: 'stop'; readonly stop: StopRecord }
  | {
      readonly kind: 'failure'
      readonly atMs: number
      /** The API error's type and details, as the hook recorded them. */
      readonly error?: string
      readonly errorDetails?: string
    }
  /** Another turn began without a Stop of this one: an interrupt, or the next turn's record. */
  | { readonly kind: 'next'; readonly atMs: number }
  | { readonly kind: 'shutdown'; readonly atMs: number }

/** What the tracker tells the server. Every hook is optional but `isOpen`. */
export interface TurnTrackerHooks {
  /** `true` while the request is delivered and not ended. */
  isOpen(requestId: string): boolean
  /** The session Claude Code is in now, for a record that names none. */
  currentSession?(): string | undefined
  /** Binding mode began. */
  bindingStarted?(): void
  /** A request started in `turn`: the turn it began, or the one it was folded into. */
  promptStarted?(requestId: string, turn: Turn, atMs: number, sessionId: string | undefined): void
  localTurnStarted?(turn: LocalTurn, atMs: number): void
  localTurnEnded?(turn: LocalTurn, outcome: Outcome, atMs: number): void
  /** Any turn ended, local or served, with its requests. */
  turnEnded?(turn: Turn, end: TurnEnd): void
}

/** What the files said when the server started. */
export interface TurnTrackerStart {
  /**
   * When this server started: a channel message sent before it (an earlier
   * server's, whose request ids restart at 1 too) binds none of its requests.
   */
  readonly sinceMs?: number | undefined
  /** The log already holds a submit with a prompt id. */
  readonly binding?: boolean
  /** The last Stop recorded before start. */
  readonly lastStopMs?: number | undefined
}

/** How many ended turns are remembered, to ignore their late records and name late calls. */
const ENDED_KEPT = 256

/** The prefix of a local turn's id: request ids are numbers, so the two never meet. */
export const LOCAL_TURN_PREFIX = 'local-'

type OpenTurn = {
  promptId: string
  kind: 'served' | 'local'
  startedAtMs: number
  sessionId: string | undefined
  requests: string[]
  local?: LocalTurn
}

export class TurnTracker {
  #binding: boolean
  readonly #sinceMs: number | undefined
  #current: OpenTurn | undefined
  // When the latest turn began, and the latest Stop or failure that ended one.
  #lastStartMs: number | undefined
  #lastEndMs: number | undefined
  readonly #ended = new Map<string, Turn>()
  // Each started request's prompt id.
  readonly #bound = new Map<string, string>()

  constructor(
    private readonly hooks: TurnTrackerHooks,
    start: TurnTrackerStart = {},
  ) {
    this.#binding = start.binding === true
    this.#sinceMs = start.sinceMs
    this.#lastEndMs = start.lastStopMs
  }

  /** `true` once a submit with a prompt id was seen: turns are followed by their ids. */
  binding(): boolean {
    return this.#binding
  }

  /** The turn running now, as far as the records say. */
  current(): Turn | undefined {
    return this.#current === undefined ? undefined : snapshot(this.#current)
  }

  /** The turn prompt id `promptId` names: the current one, or one that ended lately. */
  turn(promptId: string): Turn | undefined {
    if (this.#current?.promptId === promptId) return snapshot(this.#current)
    return this.#ended.get(promptId)
  }

  /** The prompt id of the turn a request started in, once it started. */
  boundTo(requestId: string): string | undefined {
    return this.#bound.get(requestId)
  }

  /** Drop a request that has left the server. */
  forget(requestId: string): void {
    this.#bound.delete(requestId)
  }

  /** UserPromptSubmit: rules 1 and 2. */
  submitted(submit: SubmitRecord): void {
    const promptId = submit.promptId
    if (promptId === undefined) return
    if (!this.#binding) {
      this.#binding = true
      this.hooks.bindingStarted?.()
    }
    if (this.#ended.has(promptId)) return
    const sessionId = submit.sessionId ?? this.hooks.currentSession?.()
    const requestId = submit.requestId
    if (requestId !== undefined) {
      // An earlier server's message, still queued in Claude Code, names a
      // request id this server may have handed out again: it binds none.
      const stale =
        this.#sinceMs !== undefined && submit.sentAtMs !== undefined && submit.sentAtMs < this.#sinceMs
      const open = !stale && !this.#bound.has(requestId) && this.hooks.isOpen(requestId)
      if (this.#current?.promptId !== promptId) {
        this.#end({ kind: 'next', atMs: submit.atMs })
        this.#begin({ promptId, kind: 'served', startedAtMs: submit.atMs, sessionId, requests: [] })
      }
      if (!open) return
      const current = this.#current!
      current.requests.push(requestId)
      this.#bound.set(requestId, promptId)
      this.hooks.promptStarted?.(requestId, snapshot(current), submit.atMs, sessionId)
      return
    }
    if (this.#current?.promptId === promptId) return
    this.#end({ kind: 'next', atMs: submit.atMs })
    this.#beginLocal(promptId, submit.atMs, sessionId)
  }

  /** A tool call: rule 3. */
  activity(activity: TurnActivity): void {
    if (!this.#binding || activity.promptId === undefined) return
    this.#surface(activity.promptId, activity.atMs, undefined)
  }

  /** A recorded Stop: rules 3 and 4. */
  stopped(stop: StopRecord): void {
    if (!this.#binding || stop.promptId === undefined) return
    const opened = this.#surface(stop.promptId, stop.atMs, stop.sessionId)
    const current = this.#current
    if (current?.promptId !== stop.promptId) return
    if (!opened && stop.atMs <= current.startedAtMs) return
    this.#lastEndMs = stop.atMs
    this.#end({ kind: 'stop', stop })
  }

  /** A StopFailure: rules 3 and 4. */
  failed(failure: FailureRecord): void {
    if (!this.#binding || failure.promptId === undefined) return
    const opened = this.#surface(failure.promptId, failure.atMs, failure.sessionId)
    const current = this.#current
    if (current?.promptId !== failure.promptId) return
    if (!opened && failure.atMs <= current.startedAtMs) return
    this.#lastEndMs = failure.atMs
    this.#end({
      kind: 'failure',
      atMs: failure.atMs,
      ...(failure.error !== undefined ? { error: failure.error } : {}),
      ...(failure.errorDetails !== undefined ? { errorDetails: failure.errorDetails } : {}),
    })
  }

  /** Rule 5: the current turn ends now. */
  shutdown(atMs: number): void {
    this.#end({ kind: 'shutdown', atMs })
  }

  /**
   * Rule 3: a record of a turn no submit announced begins a local turn.
   * Returns `true` when it did.
   */
  #surface(promptId: string, atMs: number, sessionId: string | undefined): boolean {
    if (this.#current?.promptId === promptId || this.#ended.has(promptId)) return false
    const lastEnd = this.#lastEndMs
    const since =
      lastEnd !== undefined && lastEnd <= atMs && (this.#lastStartMs === undefined || lastEnd > this.#lastStartMs)
        ? lastEnd
        : atMs
    this.#end({ kind: 'next', atMs: since })
    this.#beginLocal(promptId, since, sessionId ?? this.hooks.currentSession?.())
    return true
  }

  #beginLocal(promptId: string, atMs: number, sessionId: string | undefined): void {
    const local: LocalTurn = Object.freeze({
      id: `${LOCAL_TURN_PREFIX}${promptId}`,
      local: true as const,
      ...(sessionId !== undefined ? { sessionId } : {}),
    })
    this.#begin({ promptId, kind: 'local', startedAtMs: atMs, sessionId, requests: [], local })
    this.hooks.localTurnStarted?.(local, atMs)
  }

  #begin(turn: OpenTurn): void {
    this.#current = turn
    this.#lastStartMs = turn.startedAtMs
  }

  #end(end: TurnEnd): void {
    const open = this.#current
    if (open === undefined) return
    this.#current = undefined
    const turn = snapshot(open)
    this.#ended.set(turn.promptId, turn)
    if (this.#ended.size > ENDED_KEPT) this.#ended.delete(this.#ended.keys().next().value!)
    this.hooks.turnEnded?.(turn, end)
    if (turn.local !== undefined) {
      const atMs = end.kind === 'stop' ? end.stop.atMs : end.atMs
      this.hooks.localTurnEnded?.(turn.local, end.kind === 'failure' ? 'error' : 'ok', atMs)
    }
  }
}

function snapshot(turn: OpenTurn): Turn {
  return {
    promptId: turn.promptId,
    kind: turn.kind,
    startedAtMs: turn.startedAtMs,
    ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
    requests: [...turn.requests],
    ...(turn.local !== undefined ? { local: turn.local } : {}),
  }
}

import type { LocalTurn, Outcome } from './extensions.js'
import {
  CHANNEL_BATCH_MS,
  type FailureRecord,
  type StopRecord,
  type SubmitRecord,
  type TurnActivity,
} from './session-id.js'

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
 *   - an interrupt (Esc) gives no Stop; the next turn has a new id;
 *   - channel messages that wait together are taken together: each fires
 *     its UserPromptSubmit with a prompt id of its own, about 20 ms apart,
 *     and one turn runs them all under the last of those ids (measured with
 *     three messages queued behind a typed turn, 2026-10-26).
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
 *   1. a channel submit with prompt id P: when its request is not open
 *      (an earlier server's message names an id this server never handed
 *      out) or already started, the turn is a served turn bound to no
 *      request; else, P being the current turn's, the request joins it (a
 *      fold), and otherwise a new served turn P begins, the current one
 *      ending first at the same time.
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
 *   5. at shutdown the current turn ends now;
 *   6. channel messages taken together: a channel submit under a new id
 *      that follows the one before with nothing of the served turn that
 *      one began between (no tool call, Stop, failure or other submit),
 *      renames that turn instead of ending it; {@link CHANNEL_BATCH_MS}
 *      only bounds the gap, against a lost Stop line. Its requests keep their start and are bound to
 *      the new id (`promptRebound`), the new request joins, and the earlier
 *      ids name the same turn from then on.
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
  /**
   * A started request runs in the turn of the channel message taken with it
   * (rule 6): its turn goes by `promptId` from now on.
   */
  promptRebound?(requestId: string, promptId: string): void
}

/** What the files said when the server started. */
export interface TurnTrackerStart {
  /** The log already holds a submit with a prompt id. */
  readonly binding?: boolean
  /** The last Stop recorded before start. */
  readonly lastStopMs?: number | undefined
}

/** How many ended turns are remembered, to ignore their late records and name late calls. */
const ENDED_KEPT = 256

/**
 * The prefix of a local turn's id. A request id is `<instance>-<n>`, its
 * instance 8 hex characters (`src/request-ids.ts`), so the two never meet.
 */
export const LOCAL_TURN_PREFIX = 'local-'

// Rule 6's bound, CHANNEL_BATCH_MS, is the Stop hook's too (src/session-id.ts).

type OpenTurn = {
  promptId: string
  kind: 'served' | 'local'
  startedAtMs: number
  sessionId: string | undefined
  requests: string[]
  local?: LocalTurn
  /**
   * Rule 6: until when a channel submit under a new id is taken with this
   * turn; cleared by anything of the turn but its channel submits.
   */
  batchUntilMs?: number | undefined
}

export class TurnTracker {
  #binding: boolean
  #current: OpenTurn | undefined
  // When the latest turn began, and the latest Stop or failure that ended one.
  #lastStartMs: number | undefined
  #lastEndMs: number | undefined
  readonly #ended = new Map<string, Turn>()
  // Each started request's prompt id.
  readonly #bound = new Map<string, string>()
  // Rule 6: the prompt ids of channel messages taken with a later one, to it.
  readonly #alias = new Map<string, string>()

  constructor(
    private readonly hooks: TurnTrackerHooks,
    start: TurnTrackerStart = {},
  ) {
    this.#binding = start.binding === true
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
    const id = this.#resolve(promptId)
    if (this.#current?.promptId === id) return snapshot(this.#current)
    return this.#ended.get(id)
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
    if (submit.promptId === undefined) {
      // No turn to follow, but a line of the log between two channel
      // submits all the same: they are not taken together (rule 6), as the
      // Stop hook reads it.
      if (submit.requestId === undefined) this.#breakBatch()
      return
    }
    const promptId = this.#resolve(submit.promptId)
    if (!this.#binding) {
      this.#binding = true
      this.hooks.bindingStarted?.()
    }
    if (this.#ended.has(promptId)) return
    const sessionId = submit.sessionId ?? this.hooks.currentSession?.()
    const requestId = submit.requestId
    if (requestId !== undefined) {
      // Only an open request of this server's binds. An earlier server's
      // message, still queued in Claude Code, names an id this server never
      // handed out (`src/request-ids.ts`): it binds none.
      const open = !this.#bound.has(requestId) && this.hooks.isOpen(requestId)
      const before = this.#current
      if (before?.promptId !== promptId) {
        if (before?.batchUntilMs !== undefined && submit.atMs <= before.batchUntilMs) {
          // Rule 6: delivered together with the message before; one turn.
          this.#rename(before, promptId)
        } else {
          this.#end({ kind: 'next', atMs: submit.atMs })
          this.#begin({
            promptId,
            kind: 'served',
            startedAtMs: submit.atMs,
            sessionId,
            requests: [],
            batchUntilMs: submit.atMs + CHANNEL_BATCH_MS,
          })
        }
      }
      const current = this.#current!
      if (current.batchUntilMs !== undefined) current.batchUntilMs = submit.atMs + CHANNEL_BATCH_MS
      if (!open) return
      current.requests.push(requestId)
      this.#bound.set(requestId, promptId)
      this.hooks.promptStarted?.(requestId, snapshot(current), submit.atMs, sessionId)
      return
    }
    if (this.#current?.promptId === promptId) {
      // Typed text while the turn runs: no channel message joins it later by rule 6.
      this.#breakBatch()
      return
    }
    this.#end({ kind: 'next', atMs: submit.atMs })
    this.#beginLocal(promptId, submit.atMs, sessionId)
  }

  /** A tool call: rule 3. */
  activity(activity: TurnActivity): void {
    if (!this.#binding || activity.promptId === undefined) return
    const promptId = this.#resolve(activity.promptId)
    this.#surface(promptId, activity.atMs, undefined)
    // The turn runs: a channel message taken from here on is folded in.
    if (this.#current?.promptId === promptId) this.#current.batchUntilMs = undefined
  }

  /** A recorded Stop: rules 3 and 4. */
  stopped(stop: StopRecord): void {
    if (!this.#binding) return
    if (stop.promptId === undefined) {
      this.#breakBatch()
      return
    }
    const promptId = this.#resolve(stop.promptId)
    const opened = this.#surface(promptId, stop.atMs, stop.sessionId)
    const current = this.#current
    if (current?.promptId !== promptId) return
    if (!opened && stop.atMs <= current.startedAtMs) return
    this.#lastEndMs = stop.atMs
    this.#end({ kind: 'stop', stop })
  }

  /** A StopFailure: rules 3 and 4. */
  failed(failure: FailureRecord): void {
    if (!this.#binding) return
    if (failure.promptId === undefined) {
      this.#breakBatch()
      return
    }
    const promptId = this.#resolve(failure.promptId)
    const opened = this.#surface(promptId, failure.atMs, failure.sessionId)
    const current = this.#current
    if (current?.promptId !== promptId) return
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

  /**
   * Rule 6: no channel submit joins the current turn from here on. Any line
   * of the log but a channel submit breaks a batch, here as in the Stop
   * hook's join (`waitingRequests`).
   */
  #breakBatch(): void {
    if (this.#current !== undefined) this.#current.batchUntilMs = undefined
  }

  /** The prompt id a record's id names: itself, or the one its message was taken with. */
  #resolve(promptId: string): string {
    return this.#alias.get(promptId) ?? promptId
  }

  /** Rule 6: the open turn goes by `promptId` from now on, its requests with it. */
  #rename(turn: OpenTurn, promptId: string): void {
    const from = turn.promptId
    for (const [id, to] of this.#alias) if (to === from) this.#alias.set(id, promptId)
    this.#alias.set(from, promptId)
    if (this.#alias.size > ENDED_KEPT) this.#alias.delete(this.#alias.keys().next().value!)
    turn.promptId = promptId
    for (const requestId of turn.requests) {
      this.#bound.set(requestId, promptId)
      this.hooks.promptRebound?.(requestId, promptId)
    }
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

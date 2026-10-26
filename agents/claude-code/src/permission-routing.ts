import type { FailureRecord, StopRecord, TurnActivity } from './session-id.js'

/**
 * Which served prompt a permission question belongs to, and which prompts
 * a turn left without their `done` reply.
 *
 * Claude Code asks for permission in the middle of a turn and says nothing
 * of the turn in the question: a tool name, a description, a preview. The
 * question belongs to the prompt whose turn made the tool call — not to the
 * prompt that arrived last. Claude Code runs one turn at a time; what the
 * server learns of turns comes from the plugin's hooks (`src/session-id.ts`):
 *
 *   - the Stop hook marks a turn's end, and says whether background work
 *     (tasks still running, session crons) could start another turn with
 *     no prompt at all;
 *   - the PreToolUse hook, on every tool call, records the call's prompt id
 *     and when the turn's first call was made. It runs before Claude Code
 *     asks for permission, so at a question the record is the asking turn's;
 *   - the UserPromptSubmit hook records each prompt Claude Code takes, with
 *     the prompt id of the turn it runs in, and, for a channel message, its
 *     request.
 *
 * Two modes, as the turns are followed (`src/turns.ts`).
 *
 * **By prompt id**, once this process has seen a submit with a prompt id.
 * A served prompt is bound to the prompt id its channel submit carried (the
 * turn it began, or, folded, the running one) and owns that turn: a
 * question goes to the one open prompt bound to the asking call's prompt
 * id, and with several (prompts folded into one turn) or none, it is
 * denied. A prompt not yet taken into a turn owns nothing: Claude Code
 * queues it behind the running turn, and that turn's questions are not its
 * caller's. A prompt still open when its turn ends, by any rule, ends then:
 *
 *   - at the turn's Stop with no background work left, answered with the
 *     Stop's final text when the hook kept one, else with an error;
 *   - at a Stop with background work left, by the grace rule below;
 *   - at a StopFailure (an API error), with an error that names it;
 *   - when the next turn began without a Stop (an interrupt), with an
 *     error.
 *
 * A prompt never taken into a turn keeps the grace rule.
 *
 * In both modes a StopFailure ends a turn as a Stop does, without a final
 * text: Claude Code fires it instead of the Stop, and a prompt waiting for
 * that Stop would otherwise wait for its caller's limit. Where the Stop
 * would end a prompt with its final text, the failure ends it at once with
 * an error that names the API error; for the grace rule it counts as a
 * Stop.
 *
 * **The fallback**, before that, and for a Claude Code without the hook or
 * the ids, which never leaves it. At delivery the ledger cannot know
 * whether a submit will come, so its guess stays provisional until the
 * first one; from then on the binding alone counts, and overrides a guess
 * already made. The guess: a served prompt owns a turn only when that is
 * certain: it was delivered while Claude Code was quiet — the last turn
 * stopped with no background work, no tool call since, no other prompt
 * delivered since, and no earlier prompt that might still be waiting to
 * start a turn — so the next turn is the one it starts. It owns that turn
 * until the next Stop, and only while the turn's prompt id stays the one it
 * first saw. Anything less certain owns nothing, and the question is
 * denied:
 *
 *   - a prompt delivered while a turn runs: Claude Code may fold it into
 *     that turn or queue it for the next, and says neither;
 *   - a turn that started with no prompt (background work, a cron) or that
 *     continues after its prompt's Stop;
 *   - a turn whose prompt id changes without a Stop in between;
 *   - no hook records at all (hooks not installed, a Claude Code that does
 *     not report the fields).
 *
 * In the fallback, a turn the local user starts in the terminal, still
 * before its first tool call when a prompt arrives, looks quiet: that
 * prompt owns the typed turn, its Stop is refused for it, and its caller
 * gets the typed turn's final text. With the submits the typed turn is
 * known from its submit, before Claude Code runs it, and the race is gone.
 *
 * In the fallback a turn ends the prompts it leaves without their reply
 * ({@link TurnLedger.unanswered}) so:
 *
 *   - a prompt that owned its turn, at that turn's Stop when the Stop says
 *     no background work is left, or at its StopFailure: nothing else can
 *     come back to it;
 *   - any other prompt, once a Stop has come after its delivery and no turn
 *     has started within a grace period after the latest Stop. Claude Code
 *     starts a queued prompt's turn right after a Stop, so a quiet grace
 *     period says it is not queued; a turn is seen by its first tool call,
 *     so the grace period must outlast the model's first reply.
 *
 * A prompt that owned its turn carries that Stop's final text, when the
 * hook kept one, so the server can send it as the reply. The Stop hook
 * learns which prompts wait for the running turn from the server's file
 * ({@link TurnLedger.owning}, {@link TurnLedger.open}) and refuses that
 * turn's first Stop while one is open, so the model is told to reply before
 * the turn ends; by prompt id, it joins that file with the hooks' log by
 * itself, since a short turn's Stop comes before the server's next poll.
 */

/** What the hook files say right now. */
export interface TurnView {
  readonly stop: StopRecord | undefined
  readonly activity: TurnActivity | undefined
  /** The SessionStart hook ran for this Claude Code process. */
  readonly hooksActive: boolean
}

/** A served prompt a turn left without its `done` reply, and why it is ended. */
export type TurnEnd = {
  readonly requestId: string
  readonly reason:
    | 'its turn ended'
    | 'its turn failed'
    | 'another turn began'
    | 'no turn started for it'
  /** Its turn's final text, for a prompt that owned the turn, when the hook kept one. */
  readonly finalText?: string
  /** The API error that ended its turn (a StopFailure); never with a final text. */
  readonly failure?: TurnFailure
}

/** The API error a StopFailure reported. */
export type TurnFailure = {
  readonly error?: string
  readonly errorDetails?: string
}

/**
 * What the caller of a prompt whose turn failed on an API error is told, in
 * its error frame, and what the plugin logs: the error's type, and its
 * details when the hook kept them. One line, as a header value must be.
 */
export function turnFailedDescription(failure: TurnFailure): string {
  const error = failure.error ?? 'unknown'
  return (
    `the turn failed on a model API error: ${error}` +
    (failure.errorDetails !== undefined ? ` (${failure.errorDetails})` : '')
  )
}

/** A Stop or a StopFailure, as the ledger counts turn ends. */
type TurnStop = StopRecord & { readonly failure?: TurnFailure }

/** How a turn a prompt is bound to ended, by prompt id. */
export type BoundTurnEnd =
  | { readonly kind: 'stop'; readonly stop: StopRecord }
  | { readonly kind: 'failure'; readonly failure: TurnFailure }
  | { readonly kind: 'next' }
  | { readonly kind: 'shutdown' }

/** The request a question goes to, or why it goes to none. */
export type QuestionOwner =
  | { readonly kind: 'owner'; readonly requestId: string }
  | { readonly kind: 'none'; readonly reason: string }

type Delivery = {
  readonly atMs: number
  /** Stops seen before the delivery. */
  readonly stopsBefore: number
  /** Delivered while Claude Code was quiet: it starts the next turn (the fallback's guess). */
  readonly startsTurn: boolean
  /** The fallback: the prompt id of the turn it owns, bound at its first question. */
  promptId?: string
  /** The first Stop (or StopFailure) seen after the delivery. */
  firstStop?: TurnStop
  /** By prompt id: the turn it was taken into. */
  boundTo?: string
  /** By prompt id: its turn ended while it was open, and how it is ended. */
  ended?: Omit<TurnEnd, 'requestId'>
  /** By prompt id: its turn stopped with background work left; the grace rule decides. */
  graced?: boolean
}

export class TurnLedger {
  private readonly deliveries = new Map<string, Delivery>()
  private stops = 0
  private lastStop: TurnStop | undefined
  private lastDeliveryMs: number | undefined
  private byPromptId = false

  /**
   * @param finished `true` once a request has ended (replied, expired,
   *   refused) or is no longer known; a finished request neither owns a
   *   turn nor holds back others.
   */
  constructor(private readonly finished: (requestId: string) => boolean) {}

  /** From now on, ownership is by prompt id only. */
  startBinding(): void {
    this.byPromptId = true
  }

  /** `true` once ownership is by prompt id. */
  binding(): boolean {
    return this.byPromptId
  }

  /** A request was taken into the turn `promptId`: it owns that turn from now on. */
  bind(requestId: string, promptId: string): void {
    const d = this.deliveries.get(requestId)
    if (d !== undefined) d.boundTo = promptId
  }

  /** The turn `promptId` ended: the open prompts bound to it end with it. */
  turnEnded(promptId: string, end: BoundTurnEnd): void {
    if (end.kind === 'shutdown') return
    for (const [requestId, d] of this.deliveries) {
      if (d.boundTo !== promptId || this.finished(requestId) || d.ended !== undefined) continue
      if (end.kind === 'stop') {
        if (end.stop.background === false) {
          const finalText = end.stop.finalText
          d.ended = { reason: 'its turn ended', ...(finalText !== undefined ? { finalText } : {}) }
        } else {
          d.graced = true
        }
      } else if (end.kind === 'failure') {
        d.ended = { reason: 'its turn failed', failure: end.failure }
      } else {
        d.ended = { reason: 'another turn began' }
      }
    }
  }

  /**
   * Count a Stop the watcher or a read saw; the same record counts once,
   * and one older than the last counted not at all: the watcher reports
   * every Stop of the hooks' log, and a read of `.stop` may already have
   * seen a later one.
   */
  observeStop(stop: TurnStop | undefined): void {
    if (stop === undefined) return
    if (this.lastStop !== undefined && stop.atMs <= this.lastStop.atMs) return
    for (const d of this.deliveries.values()) {
      if (d.stopsBefore === this.stops) d.firstStop = stop
    }
    this.lastStop = stop
    this.stops++
  }

  /**
   * Count a StopFailure as the end of a turn: as a Stop with no background
   * work left, and no final text, which ends the prompt that owned the turn
   * with the API error.
   */
  observeFailure(failure: FailureRecord): void {
    this.observeStop({
      ...(failure.sessionId !== undefined ? { sessionId: failure.sessionId } : {}),
      background: false,
      atMs: failure.atMs,
      failure: {
        ...(failure.error !== undefined ? { error: failure.error } : {}),
        ...(failure.errorDetails !== undefined ? { errorDetails: failure.errorDetails } : {}),
      },
    })
  }

  /**
   * The served prompts, not yet finished, that no turn will answer as of
   * `nowMs`. By prompt id: one whose turn ended, and one never taken into a
   * turn (or whose turn left background work) once `graceMs` has passed
   * since the latest Stop with no turn started. In the fallback: one that
   * owned a turn now stopped with nothing left in the background, and one
   * whose ownership was never certain, by the same grace rule.
   */
  unanswered(view: TurnView, nowMs: number, graceMs: number): TurnEnd[] {
    this.observeStop(view.stop)
    const last = this.lastStop
    if (last === undefined && !this.byPromptId) return []
    const turnStarted =
      last !== undefined && view.activity !== undefined && view.activity.atMs > last.atMs
    const graceOver = last !== undefined && !turnStarted && nowMs - last.atMs >= graceMs
    const ended: TurnEnd[] = []
    for (const [requestId, d] of this.deliveries) {
      if (this.finished(requestId)) continue
      if (this.byPromptId) {
        if (d.ended !== undefined) {
          ended.push({ requestId, ...d.ended })
          continue
        }
        // Taken into a turn that still runs: that turn's end decides.
        if (d.boundTo !== undefined && d.graced !== true) continue
        if (d.firstStop !== undefined && graceOver) {
          ended.push({ requestId, reason: 'no turn started for it' })
        }
        continue
      }
      if (d.firstStop === undefined) continue
      if (d.startsTurn && d.firstStop.background === false && d.firstStop.atMs > d.atMs) {
        const failure = d.firstStop.failure
        if (failure !== undefined) {
          ended.push({ requestId, reason: 'its turn failed', failure })
          continue
        }
        const finalText = d.firstStop.finalText
        ended.push({
          requestId,
          reason: 'its turn ended',
          ...(finalText !== undefined ? { finalText } : {}),
        })
      } else if (graceOver) {
        ended.push({ requestId, reason: 'no turn started for it' })
      }
    }
    return ended
  }

  /**
   * Record a prompt handed to Claude Code at `nowMs`. Returns whether, by
   * the fallback's guess, it starts the next turn (Claude Code was quiet),
   * which is what lets it own that turn's questions there.
   */
  delivered(requestId: string, view: TurnView, nowMs: number): boolean {
    this.observeStop(view.stop)
    const startsTurn = this.quiet(view)
    this.deliveries.set(requestId, { atMs: nowMs, stopsBefore: this.stops, startsTurn })
    this.lastDeliveryMs = nowMs
    return startsTurn
  }

  /**
   * The open prompts that own the running turn, or the next one. By prompt
   * id: those taken into a turn that has not ended. In the fallback: those
   * delivered while Claude Code was quiet, with no Stop seen since. At most
   * one in practice; the Stop hook names them when it refuses a stop.
   */
  owning(): string[] {
    const ids: string[] = []
    for (const [requestId, d] of this.deliveries) {
      if (this.finished(requestId)) continue
      const owns = this.byPromptId
        ? d.boundTo !== undefined && d.ended === undefined && d.graced !== true
        : d.startsTurn && d.stopsBefore === this.stops
      if (owns) ids.push(requestId)
    }
    return ids
  }

  /** Every open prompt delivered, whatever turn it waits for. */
  open(): string[] {
    return [...this.deliveries.keys()].filter((requestId) => !this.finished(requestId))
  }

  /** Drop a request that has left the server. */
  forget(requestId: string): void {
    this.deliveries.delete(requestId)
  }

  /** The request a permission question asked now belongs to, if certain. */
  ownerOf(view: TurnView): QuestionOwner {
    this.observeStop(view.stop)
    const activity = view.activity
    const stopMs = this.lastStop?.atMs
    if (activity === undefined || (stopMs !== undefined && activity.atMs <= stopMs)) {
      return { kind: 'none', reason: 'no tool call recorded for the current turn' }
    }
    if (activity.promptId === undefined) {
      return { kind: 'none', reason: 'the tool call carries no prompt id' }
    }
    if (this.byPromptId) {
      const bound = [...this.deliveries].filter(
        ([requestId, d]) => d.boundTo === activity.promptId && !this.finished(requestId),
      )
      if (bound.length === 1) return { kind: 'owner', requestId: bound[0]![0] }
      return {
        kind: 'none',
        reason:
          bound.length === 0
            ? 'no served prompt started the current turn'
            : 'several served prompts share the current turn',
      }
    }
    const owners = [...this.deliveries].filter(
      ([, d]) => d.startsTurn && d.stopsBefore === this.stops && activity.firstMs >= d.atMs,
    )
    if (owners.length !== 1) {
      return { kind: 'none', reason: 'no served prompt started the current turn' }
    }
    const [requestId, delivery] = owners[0]!
    delivery.promptId ??= activity.promptId
    if (delivery.promptId !== activity.promptId) {
      return { kind: 'none', reason: 'the turn changed without a Stop' }
    }
    return { kind: 'owner', requestId }
  }

  /** Claude Code is idle, and nothing but the prompt now delivered can start its next turn. */
  private quiet(view: TurnView): boolean {
    if (!view.hooksActive) return false
    const stopMs = this.lastStop?.atMs
    // Before any Stop the session has run no turn to leave work behind.
    if (view.stop !== undefined && view.stop.background !== false) return false
    if (view.activity !== undefined && (stopMs === undefined || view.activity.atMs > stopMs)) {
      return false
    }
    if (this.lastDeliveryMs !== undefined && (stopMs === undefined || this.lastDeliveryMs > stopMs)) {
      return false
    }
    for (const [requestId, d] of this.deliveries) {
      if (this.finished(requestId)) continue
      // A prompt delivered during a turn may still be queued for the turn
      // after that turn's Stop; only a second Stop proves it was taken.
      if (!d.startsTurn && this.stops - d.stopsBefore < 2) return false
    }
    return true
  }
}

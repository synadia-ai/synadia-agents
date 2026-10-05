import type { StopRecord, TurnActivity } from './session-id.js'

/**
 * Which served prompt a permission question belongs to.
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
 *     asks for permission, so at a question the record is the asking turn's.
 *
 * A served prompt owns a turn only when that is certain: it was delivered
 * while Claude Code was quiet — the last turn stopped with no background
 * work, no tool call since, no other prompt delivered since, and no earlier
 * prompt that might still be waiting to start a turn — so the next turn is
 * the one it starts. It owns that turn until the next Stop, and only while
 * the turn's prompt id stays the one it first saw. Anything less certain
 * owns nothing, and the question is denied:
 *
 *   - a prompt delivered while a turn runs: Claude Code may fold it into
 *     that turn or queue it for the next, and says neither;
 *   - a turn that started with no prompt (background work, a cron) or that
 *     continues after its prompt's Stop;
 *   - a turn whose prompt id changes without a Stop in between;
 *   - no hook records at all (hooks not installed, a Claude Code that does
 *     not report the fields).
 *
 * One race stays: a turn the local user starts in the terminal, still
 * before its first tool call when a prompt arrives, looks quiet. The
 * terminal shows that user the same permission dialog.
 *
 * The same ledger says which served prompts a turn left without their
 * `done` reply ({@link TurnLedger.unanswered}), so the server can end them
 * rather than leave their callers waiting:
 *
 *   - a prompt that owned its turn, at that turn's Stop when the Stop says
 *     no background work is left: nothing else can come back to it;
 *   - any other prompt, once a Stop has come after its delivery and no turn
 *     has started within a grace period after the latest Stop. Claude Code
 *     starts a queued prompt's turn right after a Stop, so a quiet grace
 *     period says it is not queued; a turn is seen by its first tool call,
 *     so the grace period must outlast the model's first reply.
 *
 * A prompt that owned its turn carries that Stop's final text, when the
 * hook kept one, so the server can send it as the reply. The Stop hook
 * learns which prompts own the running turn ({@link TurnLedger.owning}) and
 * refuses that turn's first Stop while one is open, so the model is told to
 * reply before the turn ends.
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
  readonly reason: 'its turn ended' | 'no turn started for it'
  /** Its turn's final text, for a prompt that owned the turn, when the hook kept one. */
  readonly finalText?: string
}

/** The request a question goes to, or why it goes to none. */
export type QuestionOwner =
  | { readonly kind: 'owner'; readonly requestId: string }
  | { readonly kind: 'none'; readonly reason: string }

type Delivery = {
  readonly atMs: number
  /** Stops seen before the delivery. */
  readonly stopsBefore: number
  /** Delivered while Claude Code was quiet: it starts the next turn. */
  readonly startsTurn: boolean
  /** The prompt id of the turn it owns, bound at its first question. */
  promptId?: string
  /** The first Stop seen after the delivery. */
  firstStop?: StopRecord
}

export class TurnLedger {
  private readonly deliveries = new Map<string, Delivery>()
  private stops = 0
  private lastStop: StopRecord | undefined
  private lastDeliveryMs: number | undefined

  /**
   * @param finished `true` once a request has ended (replied, expired,
   *   refused) or is no longer known; a finished request neither owns a
   *   turn nor holds back others.
   */
  constructor(private readonly finished: (requestId: string) => boolean) {}

  /** Count a Stop the watcher or a read saw; the same record counts once. */
  observeStop(stop: StopRecord | undefined): void {
    if (stop === undefined || stop.atMs === this.lastStop?.atMs) return
    for (const d of this.deliveries.values()) {
      if (d.stopsBefore === this.stops) d.firstStop = stop
    }
    this.lastStop = stop
    this.stops++
  }

  /**
   * The served prompts, not yet finished, that no turn will answer as of
   * `nowMs`: one that owned a turn now stopped with nothing left in the
   * background, and one whose ownership was never certain once `graceMs`
   * has passed since the latest Stop with no turn started.
   */
  unanswered(view: TurnView, nowMs: number, graceMs: number): TurnEnd[] {
    this.observeStop(view.stop)
    const last = this.lastStop
    if (last === undefined) return []
    const turnStarted = view.activity !== undefined && view.activity.atMs > last.atMs
    const graceOver = !turnStarted && nowMs - last.atMs >= graceMs
    const ended: TurnEnd[] = []
    for (const [requestId, d] of this.deliveries) {
      if (d.firstStop === undefined || this.finished(requestId)) continue
      if (d.startsTurn && d.firstStop.background === false && d.firstStop.atMs > d.atMs) {
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
   * Record a prompt handed to Claude Code at `nowMs`. Returns whether it
   * starts the next turn (Claude Code was quiet), which is what lets it
   * own that turn's questions.
   */
  delivered(requestId: string, view: TurnView, nowMs: number): boolean {
    this.observeStop(view.stop)
    const startsTurn = this.quiet(view)
    this.deliveries.set(requestId, { atMs: nowMs, stopsBefore: this.stops, startsTurn })
    this.lastDeliveryMs = nowMs
    return startsTurn
  }

  /**
   * The open prompts that own the running turn, or the next one: delivered
   * while Claude Code was quiet, with no Stop seen since. At most one in
   * practice; the Stop hook names them when it refuses a stop.
   */
  owning(): string[] {
    const ids: string[] = []
    for (const [requestId, d] of this.deliveries) {
      if (d.startsTurn && d.stopsBefore === this.stops && !this.finished(requestId)) {
        ids.push(requestId)
      }
    }
    return ids
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

/**
 * Whether Claude Code takes the prompts the channel hands it.
 *
 * Claude Code decides once per MCP server, after `initialize`, whether it
 * delivers that server's `notifications/claude/channel` messages: it needs
 * the channel capability, the channel named on its command line, and its
 * channels feature available, which it is not without an Anthropic API key
 * of its own, after a No to its "Do you want to use this API key?"
 * question, or with a key whose scope is the organization rather than a
 * workspace. When it says no, it drops every channel message silently and
 * tells the server nothing: Claude Code 2.1.331 was measured to send the
 * same `initialize` (the same client capabilities), the same `SessionStart`
 * hook input and no request of any kind in all three cases, channel on or
 * off. The MCP server, the tools and the hooks work either way.
 *
 * What does differ is what follows a channel message while Claude Code is
 * idle. Channel on, Claude Code takes it into a turn at once: its
 * `UserPromptSubmit` hook fired 30 to 50 ms after the notification, with
 * text typed but not sent in the input and with the transcript view
 * (ctrl+o) open; only an open picker (`/model`) held it, until it was
 * closed. Channel off, nothing ever fires. So a prompt delivered while
 * Claude Code is idle, and not taken within a bound
 * ({@link DEFAULT_IDLE_TURN_START_MS}) of idle time, says the channel is
 * off, and its caller is told so at once instead of waiting for the
 * request TTL.
 *
 * The rules:
 *
 *   - the bound runs only while no turn runs: from the delivery, or from
 *     the end of the turn running then. A prompt queued behind a busy turn
 *     is never cut; Claude Code takes it at that turn's next tool result or
 *     after its Stop;
 *   - once Claude Code took one channel message, the channel is on for the
 *     rest of the session, and the check stands down: a dialog held open
 *     later never cuts a prompt;
 *   - the server applies it only when it can see a turn start: the plugin's
 *     hooks run in this Claude Code process, and Claude Code, by the
 *     version it gave in `initialize`, reports a channel message's
 *     `UserPromptSubmit` ({@link channelCheckable}).
 *
 * Stated honestly: an interrupted turn (Esc) records no Stop, so the turn
 * looks busy until the next one begins, and a prompt delivered meanwhile
 * keeps the older rules; and a first prompt that arrives while a picker
 * stays open past the bound is cut although the channel is on.
 */

/**
 * The bound: how long a prompt delivered while Claude Code is idle may wait
 * for Claude Code to take it into a turn. Thirty seconds: Claude Code takes
 * it within tens of milliseconds and the server sees that within one poll
 * of the hooks' log, so this is about a hundred times the normal case, and
 * still short enough that a caller learns of an off channel while it waits.
 */
export const DEFAULT_IDLE_TURN_START_MS = 30_000

/**
 * The oldest Claude Code measured to fire `UserPromptSubmit` for a channel
 * message (`src/turns.ts`): below it the check stays off.
 */
export const MIN_CLAUDE_CODE_VERSION: readonly [number, number, number] = [2, 1, 310]

/** The MCP client's name and version, as its `initialize` gave them. */
export type ClientInfo = { readonly name?: string; readonly version?: string }

/**
 * `true` iff the client is Claude Code at {@link MIN_CLAUDE_CODE_VERSION} or
 * later. Any other client, a version that does not parse, or none: `false`.
 */
export function channelCheckable(client: ClientInfo | undefined): boolean {
  if (client?.name !== 'claude-code' || typeof client.version !== 'string') return false
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(client.version)
  if (!match) return false
  const version = [Number(match[1]), Number(match[2]), Number(match[3])]
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== MIN_CLAUDE_CODE_VERSION[i]) return version[i]! > MIN_CLAUDE_CODE_VERSION[i]!
  }
  return true
}

/** What the hooks say Claude Code is doing now. */
export type IdleState =
  | { readonly busy: true }
  /** Idle; `sinceMs` is when the last turn ended, if one did. */
  | { readonly busy: false; readonly sinceMs?: number | undefined }

/** The bound as the caller and the log read it: `30 s`, or `1500 ms`. */
export function formatBound(boundMs: number): string {
  return boundMs % 1000 === 0 ? `${boundMs / 1000} s` : `${boundMs} ms`
}

/** The §9 code a caller gets for a prompt Claude Code did not take: the session cannot take prompts. */
export const CHANNEL_OFF_CODE = 503

/**
 * The longest error description the protocol SDK sends whole: it cuts a
 * longer one to this many characters (`sanitizeErrorDesc` in
 * `@synadia-ai/agent-service`).
 */
export const MAX_ERROR_DESCRIPTION = 200

/**
 * What the caller of a prompt Claude Code did not take is told, in its
 * error frame: what happened and the likely causes, in one line of at most
 * {@link MAX_ERROR_DESCRIPTION} characters. The log's warning
 * ({@link channelOffWarning}) says the rest.
 */
export function channelOffDescription(boundMs: number): string {
  return (
    `Claude Code did not take this prompt within ${formatBound(boundMs)} while idle: its channel is likely off. ` +
    'Check: its own ANTHROPIC_API_KEY, Yes to "Do you want to use this API key?", a workspace-scoped key'
  )
}

/**
 * The prompts delivered and not yet taken, and whether Claude Code has
 * taken any: the rules above, on a clock the caller passes in.
 */
export class ChannelCheck {
  #on = false
  #reported = false
  readonly #waiting = new Map<string, number>()

  /** @param boundMs the bound; 0 turns the check off. */
  constructor(readonly boundMs: number) {}

  /** `true` once Claude Code took a channel message: the channel is on. */
  get on(): boolean {
    return this.#on
  }

  /** A prompt was handed to Claude Code at `atMs`. */
  delivered(requestId: string, atMs: number): void {
    if (this.boundMs <= 0 || this.#on) return
    this.#waiting.set(requestId, atMs)
  }

  /**
   * Claude Code took a channel message, this server's `requestId` or
   * another's: the channel is on, and no prompt waits on the bound any more.
   */
  taken(): void {
    this.#on = true
    this.#waiting.clear()
  }

  /** Drop a request that has left the server. */
  forget(requestId: string): void {
    this.#waiting.delete(requestId)
  }

  /**
   * The prompts Claude Code has left untaken for the bound while idle, as
   * of `nowMs`: each is dropped here, and the server ends it.
   */
  due(nowMs: number, idle: IdleState): string[] {
    if (this.boundMs <= 0 || this.#on || idle.busy) return []
    const due: string[] = []
    for (const [requestId, deliveredMs] of this.#waiting) {
      const sinceMs = Math.max(deliveredMs, idle.sinceMs ?? deliveredMs)
      if (nowMs - sinceMs >= this.boundMs) due.push(requestId)
    }
    for (const requestId of due) this.#waiting.delete(requestId)
    return due
  }

  /** `true` the first time only: the server says once that the channel looks off. */
  firstOff(): boolean {
    if (this.#reported) return false
    this.#reported = true
    return true
  }
}

/**
 * The warning the server logs once, at the first prompt Claude Code did not
 * take: what the callers are told, and every likely cause.
 */
export function channelOffWarning(boundMs: number): string {
  return (
    `warning: Claude Code did not take a prompt within ${formatBound(boundMs)} while idle; its channel is likely off, ` +
    'and each prompt it leaves untaken while idle is answered with an error. Check that Claude Code was started with ' +
    'the channel flag (--channels or --dangerously-load-development-channels), that it has an Anthropic API key of its ' +
    'own (ANTHROPIC_API_KEY), that its question "Do you want to use this API key?" was answered Yes, and that the ' +
    "key's scope is a workspace, not the organization. With the channel off, Claude Code lists \"Channels are not " +
    'currently available" among its start notices (ctrl+o).'
  )
}

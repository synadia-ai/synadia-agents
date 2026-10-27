import { randomBytes } from 'node:crypto'

/**
 * The ids a server gives its requests: `<instance>-<n>`. `<instance>` is 8
 * hex characters drawn at random when the server starts, `<n>` counts from
 * 1. A channel message an earlier server sent, still queued in Claude
 * Code, names an id no request of this server has: the model's `reply` to
 * it is refused, and its submit binds nothing (`src/turns.ts`) and is
 * taken in by no Stop (`src/session-id.ts`), whatever the clock says. An
 * instance is hex, so no id starts with `local-`, a local turn's prefix.
 * Every id matches the request id rule of the hooks' files,
 * `^[A-Za-z0-9_-]{1,64}$`.
 */
export function requestIdSequence(): () => string {
  const instance = randomBytes(4).toString('hex')
  let n = 0
  return () => `${instance}-${++n}`
}

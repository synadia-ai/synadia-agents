/**
 * The `served` record — this channel's binding of one prompt execution to
 * the Claude Code session whose model calls answered it.
 *
 * An SDK-built agent stamps the caller's thread on every model request it
 * makes (`PromptResponse.traceHeaders()`). An MCP server inside a Claude
 * Code session cannot: the session's requests carry Claude Code's own
 * session id, set per session, not per prompt. The channel publishes the
 * binding instead: one record at `start`, stamped with the prompt's
 * arrival and naming the caller's thread and the session id, bare, under
 * `harness: claude` — exactly the string the proxy files the session's
 * calls under (afo-design.md §6.1, §8.3, 2026-09-17) — and
 * one at `end` with the outcome. The model calls the session made between
 * the two belong to the thread.
 *
 * Both records are signed with `Agent-Sender` by the host identity and
 * carry one id as body `record_id`, header nonce and `Nats-Msg-Id`, like
 * the SDK's edge records, and count toward the same process-wide trace
 * record counts the service reports on its heartbeat. Publishing is
 * asynchronous and fail-open: a prompt is never delayed or failed by it.
 */

import { headers as createHeaders, type NatsConnection } from '@nats-io/transport-node'
import {
  AGENT_SENDER_HEADER,
  countTraceRecordDropped,
  countTraceRecordPublished,
  randomThreadId,
  serializeSenderHeader,
  signSenderHeader,
  type AgentId,
  type Logger,
  type SenderSigner,
  type TraceScope,
} from '@synadia-ai/agents'
import { isClaudeSessionId } from './session-id.js'

// Bump every time the served record schema changes.
export const SERVED_RECORD_VERSION = 1

/** The harness namespace this channel's records live in. */
export const HARNESS = 'claude'

export type ServedPhase = 'start' | 'end'
/** How the turn ended: answered, failed, or expired on the request TTL. */
export type ServedStatus = 'ok' | 'error' | 'timeout'

/** Now, in unix seconds — the served record's `ts` resolution. */
export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** One built served record: its wire bytes and the id that de-duplicates it. */
export interface BuiltServedRecord {
  readonly recordId: string
  readonly payload: Uint8Array
}

/**
 * One served record, ready to publish. The record id comes back alongside
 * the payload so the publisher can stamp it as `Nats-Msg-Id` and sign
 * with it as the `Agent-Sender` nonce. `agent` is the host identity, in
 * canonical `{account}.{user}` form — the identity that signs the record.
 * `sessionId` is the bare Claude Code session id; the record carries it
 * as is, next to the harness kind, never prefixed. `status` is required on `end` and must
 * be absent on `start`. `ts` is unix seconds — when the prompt arrived
 * for `start`, when the turn ended for `end`.
 */
export function buildServedRecord(
  agent: AgentId,
  threadId: string,
  rootId: string,
  sessionId: string,
  phase: ServedPhase,
  status?: ServedStatus,
  ts: number = unixSeconds(),
): BuiltServedRecord {
  if (phase === 'end' && status === undefined) {
    throw new Error('buildServedRecord: an end record needs a status')
  }
  if (phase === 'start' && status !== undefined) {
    throw new Error('buildServedRecord: a start record carries no status')
  }
  if (!Number.isInteger(ts) || ts < 0) {
    throw new Error('buildServedRecord: ts must be a non-negative integer of unix seconds')
  }
  if (!isClaudeSessionId(sessionId)) {
    throw new Error('buildServedRecord: sessionId is not a Claude Code session id')
  }
  const recordId = randomThreadId()
  const record = {
    version: SERVED_RECORD_VERSION,
    kind: 'served',
    record_id: recordId,
    ts,
    agent,
    thread_id: threadId,
    root_id: rootId,
    harness: HARNESS,
    harness_thread_id: sessionId,
    phase,
    ...(status !== undefined ? { status } : {}),
  }
  return {
    recordId,
    payload: new TextEncoder().encode(JSON.stringify(record)),
  }
}

export interface ServedPublisherOptions {
  readonly nc: NatsConnection
  /** Where the records go — the SDK's trace subject. */
  readonly subject: string
  /** The host's signer; without one nothing is published. */
  readonly signer: SenderSigner | undefined
  /** The host identity, read per record: it is known only once the service started. */
  readonly identity: () => AgentId | undefined
  readonly logger: Logger
}

/**
 * One prompt's served pair. `bind` names the session once and publishes
 * `start` stamped with the prompt's arrival; `settle` records the outcome
 * when the turn ends, stamped with that moment, and publishes `end` if
 * the session is known. A session bound after settling is refused: the
 * pair is the turn's window, not something to backfill.
 */
export interface ServedTurn {
  bind(sessionId: string | undefined): void
  /** End the turn; `ts` is the turn's end in unix seconds, now by default. */
  settle(status: ServedStatus, ts?: number): void
}

const NATS_MSG_ID_HEADER = 'Nats-Msg-Id'

export class ServedPublisher {
  readonly #options: ServedPublisherOptions
  #unsignedWarned = false
  // Records are signed and handed to the connection one after another, in
  // the order they were due, so a pair's `end` never overtakes its `start`
  // on the wire. A failed record never rejects the chain.
  #chain: Promise<void> = Promise.resolve()

  constructor(options: ServedPublisherOptions) {
    this.#options = options
  }

  /**
   * Start a prompt's pair. `scope` is the prompt's trace scope — the
   * ambient one inside the service's handler; `undefined` (an untraced
   * service) means no pair for this prompt.
   */
  beginTurn(scope: TraceScope | undefined): ServedTurn | undefined {
    if (scope === undefined) return undefined
    const arrivedAt = unixSeconds()
    let sessionId: string | undefined
    let settled = false
    return {
      bind: (id: string | undefined): void => {
        if (settled) {
          this.#options.logger.warn('served: session bound after the turn ended; no served record')
          return
        }
        if (sessionId !== undefined) {
          if (id !== sessionId) {
            this.#options.logger.warn('served: session already bound for this prompt; ignored')
          }
          return
        }
        if (!isClaudeSessionId(id)) {
          this.#options.logger.warn(
            'served: no usable Claude Code session id; no served record for this prompt',
          )
          return
        }
        sessionId = id
        this.publish(scope, id, 'start', undefined, arrivedAt)
      },
      settle: (status: ServedStatus, ts: number = unixSeconds()): void => {
        if (settled) return
        settled = true
        if (sessionId !== undefined) {
          this.publish(scope, sessionId, 'end', status, ts)
        }
      },
    }
  }

  /**
   * Publish one signed record. Fail-open and asynchronous: the returned
   * promise never rejects and nothing awaits it on the prompt path.
   * Without a signer or a host identity nothing is published — an unsigned
   * record cannot be attributed — the publisher warns once, and the record
   * counts as dropped. Every record that goes out or fails to moves the
   * process-wide trace record counts.
   */
  publish(
    scope: TraceScope,
    sessionId: string,
    phase: ServedPhase,
    status: ServedStatus | undefined,
    ts: number,
  ): Promise<void> {
    const { signer, logger } = this.#options
    const id = this.#options.identity()
    if (signer === undefined || id === undefined) {
      countTraceRecordDropped()
      if (!this.#unsignedWarned) {
        this.#unsignedWarned = true
        logger.warn(
          'served: no host identity signer; served records are not published ' +
            '(an unsigned record cannot be attributed). Set senderIdentity to signed.',
        )
      }
      return Promise.resolve()
    }
    const next = this.#chain.then(() => this.#send(id, signer, scope, sessionId, phase, status, ts))
    this.#chain = next
    return next
  }

  /**
   * Resolves once every record handed to `publish` so far has been signed
   * and handed to the connection, or dropped. For shutdown and tests.
   */
  flush(): Promise<void> {
    return this.#chain
  }

  async #send(
    id: AgentId,
    signer: SenderSigner,
    scope: TraceScope,
    sessionId: string,
    phase: ServedPhase,
    status: ServedStatus | undefined,
    ts: number,
  ): Promise<void> {
    const { nc, subject, logger } = this.#options
    try {
      const record = buildServedRecord(
        id,
        scope.threadId,
        scope.rootId,
        sessionId,
        phase,
        status,
        ts,
      )
      const header = await signSenderHeader({
        signer,
        id,
        sub: subject,
        payload: record.payload,
        nonce: record.recordId,
      })
      const hdrs = createHeaders()
      hdrs.set(AGENT_SENDER_HEADER, serializeSenderHeader(header))
      hdrs.set(NATS_MSG_ID_HEADER, record.recordId)
      nc.publish(subject, record.payload, { headers: hdrs })
      countTraceRecordPublished()
    } catch (err) {
      countTraceRecordDropped()
      logger.warn('served: failed to publish served record', {
        subject,
        phase,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

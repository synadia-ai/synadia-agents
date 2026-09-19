/**
 * The `served` record — this plugin's binding of one prompt execution to
 * the harness thread id its model calls carry.
 *
 * An SDK-built agent stamps the thread on every model request it makes,
 * so those requests carry the thread the caller minted. A channel plugin
 * cannot add a header to OpenClaw's provider requests, but every request
 * of a turn carries OpenClaw's own `traceparent`, and the plugin decides
 * its trace id by seeding OpenClaw's trace scope (see trace-scope.ts).
 * The plugin publishes the binding: one record at `start`, stamped with
 * the prompt's arrival and naming the thread and the trace id, bare, under
 * `harness: openclaw` — exactly the string the proxy files the turn's calls
 * under (afo-design.md §6.1, §8.3, 2026-09-17) —
 * and one at `end` with the outcome. Between the two, the model calls
 * carrying that id belong to the thread.
 *
 * Both records are signed with `Agent-Sender` by the host identity and
 * carry one id as body `record_id`, header nonce and `Nats-Msg-Id`, like
 * the SDK's edge records, and count toward the same process-wide trace
 * record counts the service reports on its heartbeat. Publishing is
 * asynchronous and fail-open: a prompt is never delayed or failed by it.
 */

import { headers as createHeaders, type NatsConnection } from "@nats-io/nats-core";
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
} from "@synadia-ai/agents";

// Bump every time the served record schema changes.
export const SERVED_RECORD_VERSION = 1;

/** The harness namespace this plugin's records live in. */
export const HARNESS = "openclaw";

export type ServedPhase = "start" | "end";
export type ServedStatus = "ok" | "error";

/** Longest accepted harness id, in Unicode code points. */
export const HARNESS_ID_MAX = 256;

// Same class the SDK uses for subjects: the harness id ends up in a JSON
// field matched against a header value, so anything a header value could
// never hold — empty, whitespace, control characters — is refused rather
// than published.
const FORBIDDEN =
  /[\u0000-\u0020\u007f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/** `true` iff `value` can be the harness id a served record names. */
export function validHarnessId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (FORBIDDEN.test(value)) return false;
  return Array.from(value).length <= HARNESS_ID_MAX;
}

/** Now, in unix seconds — the served record's `ts` resolution. */
export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** One built served record: its wire bytes and the id that de-duplicates it. */
export interface BuiltServedRecord {
  readonly recordId: string;
  readonly payload: Uint8Array;
}

/**
 * One served record, ready to publish. The record id comes back alongside
 * the payload so the publisher can stamp it as `Nats-Msg-Id` and sign
 * with it as the `Agent-Sender` nonce. `agent` is the host identity, in
 * canonical `{account}.{user}` form — the identity that signs the record.
 * `harnessId` is the bare trace id; the record carries it as is, next to
 * the harness kind, never prefixed. `status` is required on `end` and must be absent on
 * `start`. `ts` is unix seconds — when the prompt arrived for `start`,
 * when the turn ended for `end`.
 */
export function buildServedRecord(
  agent: AgentId,
  threadId: string,
  rootId: string,
  harnessId: string,
  phase: ServedPhase,
  status?: ServedStatus,
  ts: number = unixSeconds(),
): BuiltServedRecord {
  if (phase === "end" && status === undefined) {
    throw new Error("buildServedRecord: an end record needs a status");
  }
  if (phase === "start" && status !== undefined) {
    throw new Error("buildServedRecord: a start record carries no status");
  }
  if (!Number.isInteger(ts) || ts < 0) {
    throw new Error(
      "buildServedRecord: ts must be a non-negative integer of unix seconds",
    );
  }
  const recordId = randomThreadId();
  const record = {
    version: SERVED_RECORD_VERSION,
    kind: "served",
    record_id: recordId,
    ts,
    agent,
    thread_id: threadId,
    root_id: rootId,
    harness: HARNESS,
    harness_thread_id: harnessId,
    phase,
    ...(status !== undefined ? { status } : {}),
  };
  return {
    recordId,
    payload: new TextEncoder().encode(JSON.stringify(record)),
  };
}

export interface ServedPublisherOptions {
  readonly nc: NatsConnection;
  /** Where the records go — the SDK's trace subject. */
  readonly subject: string;
  /** The host's signer; without one nothing is published. */
  readonly signer: SenderSigner | undefined;
  /** The host identity, read per record: it is known only once the service started. */
  readonly identity: () => AgentId | undefined;
  readonly logger: Logger;
}

/**
 * One prompt's served pair. `bind` names the harness id once and publishes
 * `start` stamped with the prompt's arrival; `settle` records the outcome
 * when the turn ends and publishes `end` if the id is known. An id bound
 * after settling is refused: the pair is the turn's window, not something
 * to backfill.
 */
export interface ServedTurn {
  bind(harnessId: string): void;
  settle(status: ServedStatus): void;
}

const NATS_MSG_ID_HEADER = "Nats-Msg-Id";

export class ServedPublisher {
  readonly #options: ServedPublisherOptions;
  #unsignedWarned = false;
  // Records are signed and handed to the connection one after another, in
  // the order they were due, so a pair's `end` never overtakes its `start`
  // on the wire. A failed record never rejects the chain.
  #chain: Promise<void> = Promise.resolve();

  constructor(options: ServedPublisherOptions) {
    this.#options = options;
  }

  /**
   * Start a prompt's pair. `scope` is the prompt's trace scope — the
   * ambient one inside the service's handler; `undefined` (an untraced
   * service) means no pair for this prompt.
   */
  beginTurn(scope: TraceScope | undefined): ServedTurn | undefined {
    if (scope === undefined) return undefined;
    const arrivedAt = unixSeconds();
    let harnessId: string | undefined;
    let settled = false;
    return {
      bind: (id: string): void => {
        if (settled) {
          this.#options.logger.warn(
            "served: harness id bound after the turn ended; no served record",
          );
          return;
        }
        if (harnessId !== undefined) {
          if (id !== harnessId) {
            this.#options.logger.warn(
              "served: harness id already bound for this prompt; ignored",
            );
          }
          return;
        }
        if (!validHarnessId(id)) {
          this.#options.logger.warn(
            "served: unusable harness id bound; no served record",
          );
          return;
        }
        harnessId = id;
        this.publish(scope, id, "start", undefined, arrivedAt);
      },
      settle: (status: ServedStatus): void => {
        if (settled) return;
        settled = true;
        if (harnessId !== undefined) {
          this.publish(scope, harnessId, "end", status, unixSeconds());
        }
      },
    };
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
    harnessId: string,
    phase: ServedPhase,
    status: ServedStatus | undefined,
    ts: number,
  ): Promise<void> {
    const { signer, logger } = this.#options;
    const id = this.#options.identity();
    if (signer === undefined || id === undefined) {
      countTraceRecordDropped();
      if (!this.#unsignedWarned) {
        this.#unsignedWarned = true;
        logger.warn(
          "served: no host identity signer; served records are not published " +
            "(an unsigned record cannot be attributed). Set senderIdentity to signed.",
        );
      }
      return Promise.resolve();
    }
    const next = this.#chain.then(() =>
      this.#send(id, signer, scope, harnessId, phase, status, ts),
    );
    this.#chain = next;
    return next;
  }

  /**
   * Resolves once every record handed to `publish` so far has been signed
   * and handed to the connection, or dropped. For shutdown and tests.
   */
  flush(): Promise<void> {
    return this.#chain;
  }

  async #send(
    id: AgentId,
    signer: SenderSigner,
    scope: TraceScope,
    harnessId: string,
    phase: ServedPhase,
    status: ServedStatus | undefined,
    ts: number,
  ): Promise<void> {
    const { nc, subject, logger } = this.#options;
    try {
      const record = buildServedRecord(
        id,
        scope.threadId,
        scope.rootId,
        harnessId,
        phase,
        status,
        ts,
      );
      const header = await signSenderHeader({
        signer,
        id,
        sub: subject,
        payload: record.payload,
        nonce: record.recordId,
      });
      const hdrs = createHeaders();
      hdrs.set(AGENT_SENDER_HEADER, serializeSenderHeader(header));
      hdrs.set(NATS_MSG_ID_HEADER, record.recordId);
      nc.publish(subject, record.payload, { headers: hdrs });
      countTraceRecordPublished();
    } catch (err) {
      countTraceRecordDropped();
      logger.warn("served: failed to publish served record", {
        subject,
        phase,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

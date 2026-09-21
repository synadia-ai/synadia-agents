// Host-side sender classification: the stateful parts of the
// sender-identity extension that the shared codec in `@synadia-ai/agents`
// deliberately does not carry — the nonce set, the `min_sender_trust`
// gate, the acceptance hook, and the 400/401/403/500 mapping.
//
// Dispatch order for a `prompt` request (plan §2.8):
//   envelope 400 → header parse 400 → ts / sub / nonce-lookup / signature
//   401 → `signed` + unsigned 401 → nonce record → acceptSender 403 / 401,
//   throw → 500 → ack.
// A nonce is recorded only after every other check passed, so a stale or
// transplanted header cannot poison the set. `status` is classify-only.

import type { MsgHdrs } from "@nats-io/nats-core";
import {
  MalformedSenderHeaderError,
  parseSenderTimestamp,
  SenderVerificationError,
  SENDER_REJECTED_DESCRIPTION,
  SIGNATURE_REQUIRED_DESCRIPTION,
  verifySender,
  formatSender,
  type AgentId,
  type AgentInfo,
  type Logger,
  type MinSenderTrust,
  type SenderInfo,
} from "@synadia-ai/agents";

/** Default `min_sender_trust` — the 0.3 behaviour. */
export const DEFAULT_MIN_SENDER_TRUST: MinSenderTrust = "any";
/** Default replay window / `ts` skew (spec: 30 s). */
export const DEFAULT_REPLAY_WINDOW_MS = 30_000;
/** Default hard cap on nonce-set entries. */
export const DEFAULT_NONCE_CACHE_MAX_ENTRIES = 100_000;

/**
 * Acceptance hook: runs for every classified `prompt` request (verified,
 * claimed, absent), never for `status`. `false` for a verified sender →
 * `403`; `false` for a claimed / absent sender → `401` with the
 * `signature required` description — on the wire that reads as "sign and
 * retry", so a hook that wants to block an unsigned caller regardless of
 * signing cannot express that distinction (§9.2 leaves no code for it);
 * a throw → `500` (logged, never served). Per-request network I/O here
 * delays the §6.4 ack and is an amplification vector on `any` endpoints.
 */
export type AcceptSenderHook = (sender: SenderInfo | undefined) => boolean | Promise<boolean>;

/** The structural message shape classification needs (`Msg`, `ServiceMsg`, `JsMsg` all fit). */
export interface ClassifiableMsg {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly headers?: MsgHdrs | undefined;
}

export interface NonceCacheOptions {
  /** Entries expire at `ts + replayWindowMs`. Default 30 000. */
  readonly replayWindowMs?: number;
  /** Hard cap; the oldest second-buckets are evicted past it (logged once). Default 100 000. */
  readonly maxEntries?: number;
  readonly logger?: Logger;
}

/**
 * Per-instance, in-memory nonce set keyed by `${user}.${nonce}` (the
 * nonce alphabet excludes `.`). **Entries expire at `ts + window`, not at
 * arrival + window** — a header with `ts = now + 29 s` is legal and must
 * still be rejected on replay at arrival + 31 s. Expiry is bucketed by
 * second so sweeps are not O(n) per insert; a hard cap bounds memory.
 *
 * Documented limitations: instances behind the `agents` queue group do
 * not share it, and a restart empties it; the `ts` window bounds both.
 */
export class NonceCache {
  readonly #window: number;
  readonly #max: number;
  readonly #logger: Logger | undefined;
  readonly #expiry = new Map<string, number>();
  readonly #buckets = new Map<number, Set<string>>();
  #capWarned = false;

  constructor(opts: NonceCacheOptions = {}) {
    this.#window = opts.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    this.#max = opts.maxEntries ?? DEFAULT_NONCE_CACHE_MAX_ENTRIES;
    this.#logger = opts.logger;
  }

  get size(): number {
    return this.#expiry.size;
  }

  /**
   * True iff `(user, nonce)` is present and not expired. The stored expiry
   * is compared exactly; the second-granular buckets only bound *memory*
   * (an entry can sit in the map for up to 1 s past its expiry before the
   * sweep drops it, but it is never reported as present).
   */
  has(user: string, nonce: string, now: number = Date.now()): boolean {
    this.sweep(now);
    const expiresAt = this.#expiry.get(`${user}.${nonce}`);
    return expiresAt !== undefined && expiresAt > now;
  }

  /**
   * Check-and-set: record `(user, nonce)` expiring at `tsMs + window`.
   * Returns `false` (and records nothing) when it is already present and
   * unexpired. Synchronous on purpose — it is the authoritative CAS when
   * concurrent requests carry the same nonce (the earlier `has()` lookup
   * in classification runs across an `await`).
   */
  record(user: string, nonce: string, tsMs: number, now: number = Date.now()): boolean {
    this.sweep(now);
    const key = `${user}.${nonce}`;
    const existing = this.#expiry.get(key);
    if (existing !== undefined && existing > now) return false;
    const expiresAt = tsMs + this.#window;
    if (expiresAt <= now) return true; // already outside the window: nothing to remember
    const bucket = Math.floor(expiresAt / 1000);
    this.#expiry.set(key, expiresAt);
    let set = this.#buckets.get(bucket);
    if (!set) {
      set = new Set();
      this.#buckets.set(bucket, set);
    }
    set.add(key);
    this.#enforceCap();
    return true;
  }

  /**
   * Drop every entry whose expiry has passed. Once normal expiry has
   * brought the set down to half the cap, the cap warning is re-armed, so
   * a later overload is reported again — with hysteresis, because every
   * eviction round itself leaves the set just under the cap and a plain
   * "below the cap" reset would log on every round.
   */
  sweep(now: number = Date.now()): void {
    const nowBucket = Math.floor(now / 1000);
    for (const [bucket, keys] of this.#buckets) {
      if (bucket >= nowBucket) continue;
      for (const key of keys) this.#expiry.delete(key);
      this.#buckets.delete(bucket);
    }
    if (this.#capWarned && this.#expiry.size <= this.#max / 2) this.#capWarned = false;
  }

  #enforceCap(): void {
    if (this.#expiry.size <= this.#max) return;
    if (!this.#capWarned) {
      this.#capWarned = true;
      // Evicted nonces are replayable for the rest of their `ts` window —
      // an operator who sees this once should raise the cap.
      this.#logger?.warn(
        "nonce cache reached its cap; evicting the oldest entries — evicted nonces may be replayed within the ts window",
        { maxEntries: this.#max },
      );
    }
    const buckets = [...this.#buckets.keys()].sort((a, b) => a - b);
    for (const bucket of buckets) {
      if (this.#expiry.size <= this.#max) break;
      const keys = this.#buckets.get(bucket);
      if (keys) for (const key of keys) this.#expiry.delete(key);
      this.#buckets.delete(bucket);
    }
  }
}

export interface SenderGateOptions {
  /** Default `"any"`. */
  readonly minSenderTrust?: MinSenderTrust;
  /** Default 30 000. Also the `ts` skew. */
  readonly replayWindowMs?: number;
  /** 1-based `account_token_position` of the export the receiver sits behind. */
  readonly accountTokenPosition?: number;
  readonly acceptSender?: AcceptSenderHook;
  readonly logger?: Logger;
  /** Share a nonce set between gates (default: a fresh one). */
  readonly nonceCache?: NonceCache;
  /**
   * Operator-attested mode (spec Appendix A): cross-check a verified
   * header against the server's `Nats-Request-Info` stamp (and count the
   * `accountTokenPosition` cross-check as attestation). Off by default —
   * a deployment promise (closed endpoint) the SDK cannot verify.
   */
  readonly operatorAttested?: boolean;
  /** Reverse-lookup binding for `VerifiedSender.resolve()` (default: unbound → `undefined`). */
  readonly resolver?: (id: AgentId) => Promise<AgentInfo | undefined>;
}

/** A refusal, with the generic wire description and the log-only detail. */
export interface SenderRejection {
  readonly code: 400 | 401 | 403 | 500;
  readonly description: string;
  readonly detail: string;
}

export type SenderAdmission =
  | { readonly ok: true; readonly sender: SenderInfo | undefined }
  | ({ readonly ok: false } & SenderRejection);

const SILENT: Logger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

/**
 * Classifies inbound requests for one receiver: parse → verify (live) →
 * `min_sender_trust` → nonce record → acceptance hook. One gate per
 * `AgentService` / `ReferenceAgent`; the nonce set lives in it.
 */
export class SenderGate {
  readonly #minSenderTrust: MinSenderTrust;
  readonly #replayWindowMs: number;
  readonly #accountTokenPosition: number | undefined;
  readonly #acceptSender: AcceptSenderHook | undefined;
  readonly #logger: Logger;
  readonly #nonces: NonceCache;
  readonly #operatorAttested: boolean;
  readonly #resolver: ((id: AgentId) => Promise<AgentInfo | undefined>) | undefined;

  constructor(opts: SenderGateOptions = {}) {
    this.#minSenderTrust = opts.minSenderTrust ?? DEFAULT_MIN_SENDER_TRUST;
    this.#replayWindowMs = opts.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    this.#accountTokenPosition = opts.accountTokenPosition;
    this.#acceptSender = opts.acceptSender;
    this.#logger = opts.logger ?? SILENT;
    this.#nonces =
      opts.nonceCache ??
      new NonceCache({ replayWindowMs: this.#replayWindowMs, logger: this.#logger });
    this.#operatorAttested = opts.operatorAttested ?? false;
    this.#resolver = opts.resolver;
  }

  get minSenderTrust(): MinSenderTrust {
    return this.#minSenderTrust;
  }

  get nonceCache(): NonceCache {
    return this.#nonces;
  }

  get operatorAttested(): boolean {
    return this.#operatorAttested;
  }

  /**
   * Parse and verify (live mode) without recording anything. A malformed
   * header → `400`; a failing check → `401`; no header / unknown `v` →
   * `sender: undefined`. Non-identity exceptions propagate.
   */
  async classify(
    msg: ClassifiableMsg,
  ): Promise<{ sender: SenderInfo | undefined } | SenderRejection> {
    try {
      const sender = await verifySender(msg, "live", {
        replayWindowMs: this.#replayWindowMs,
        ...(this.#accountTokenPosition !== undefined
          ? { accountTokenPosition: this.#accountTokenPosition }
          : {}),
        nonceSeen: (user, nonce) => this.#nonces.has(user, nonce),
        operatorAttested: this.#operatorAttested,
        ...(this.#resolver !== undefined ? { resolver: this.#resolver } : {}),
      });
      return { sender };
    } catch (err) {
      if (err instanceof MalformedSenderHeaderError) {
        return { code: 400, description: "malformed Agent-Sender header", detail: err.message };
      }
      if (err instanceof SenderVerificationError) {
        return { code: err.code, description: err.description, detail: err.detail };
      }
      throw err;
    }
  }

  /**
   * The full `prompt` admission: classify, enforce `min_sender_trust`,
   * record the nonce (check-and-set), run the acceptance hook. Never
   * throws for identity reasons; logs every refusal with its detail.
   */
  async admitPrompt(msg: ClassifiableMsg): Promise<SenderAdmission> {
    const classified = await this.classify(msg);
    if ("code" in classified) return this.#refuse(msg, classified);
    const sender = classified.sender;

    if (this.#minSenderTrust === "signed" && sender?.trust !== "verified") {
      return this.#refuse(msg, {
        code: 401,
        description: SIGNATURE_REQUIRED_DESCRIPTION,
        detail: `endpoint requires a verified sender; got ${formatSender(sender)}`,
      });
    }

    if (sender?.trust === "verified") {
      const { user, nonce, ts } = sender.header;
      if (
        nonce !== undefined &&
        ts !== undefined &&
        // CAS: synchronous check-and-set; one winner when concurrent requests
        // carry the same nonce. Atomic because there is no `await` between
        // `classify()` resolving above and this call — the event loop cannot
        // interleave another request's `record()` in between (JS is
        // single-threaded); the earlier `nonceSeen` lookup inside
        // `classify()` ran across awaits and is only the cheap early exit.
        !this.#nonces.record(user, nonce, parseSenderTimestamp(ts))
      ) {
        return this.#refuse(msg, {
          code: 401,
          description: SENDER_REJECTED_DESCRIPTION,
          detail: `nonce already seen for ${user}`,
        });
      }
    }

    if (this.#acceptSender) {
      let accepted: boolean;
      try {
        accepted = await this.#acceptSender(sender);
      } catch {
        this.#logger.error("acceptSender hook threw; request not served", {
          subject: msg.subject,
          sender: formatSender(sender),
          error: "hook error",
        });
        return {
          ok: false,
          code: 500,
          description: "server error",
          detail: "acceptSender hook threw",
        };
      }
      if (!accepted) {
        return this.#refuse(
          msg,
          sender?.trust === "verified"
            ? {
                code: 403,
                description: SENDER_REJECTED_DESCRIPTION,
                detail: `verified sender not accepted: ${formatSender(sender)}`,
              }
            : {
                code: 401,
                description: SIGNATURE_REQUIRED_DESCRIPTION,
                detail: `unauthenticated sender not accepted: ${formatSender(sender)}`,
              },
        );
      }
    }

    return { ok: true, sender };
  }

  /**
   * `status`: classify, record a verified nonce into the shared set, log a
   * failure — and never reject. Returns the sender for the log line.
   */
  async classifyStatus(msg: ClassifiableMsg): Promise<SenderInfo | undefined> {
    const classified = await this.classify(msg);
    if ("code" in classified) {
      this.#logger.warn("status request: Agent-Sender rejected (reply sent anyway)", {
        subject: msg.subject,
        code: classified.code,
        reason: classified.detail,
      });
      return undefined;
    }
    const sender = classified.sender;
    if (sender?.trust === "verified") {
      const { user, nonce, ts } = sender.header;
      if (
        nonce !== undefined &&
        ts !== undefined &&
        !this.#nonces.record(user, nonce, parseSenderTimestamp(ts))
      ) {
        this.#logger.warn("status request: nonce replayed (reply sent anyway)", {
          subject: msg.subject,
          sender: formatSender(sender),
        });
        return undefined;
      }
    }
    return sender;
  }

  #refuse(msg: ClassifiableMsg, r: SenderRejection): SenderAdmission {
    this.#logger.warn("prompt request refused on sender identity", {
      subject: msg.subject,
      code: r.code,
      reason: r.detail,
    });
    return { ok: false, ...r };
  }
}

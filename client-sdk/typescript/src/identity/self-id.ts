// `selfId()` — the connection's own agent ID, live-bound then memoised by
// connection and identity source.
//
// The live source is always `$SYS.REQ.USER.INFO`. When a signer carries a
// credentials JWT, its (`account`, `user`) pair is compared with that live
// answer; the JWT is never accepted as a substitute for connection binding.
//
// Memoised per connection *and identity source* in a module-level `WeakMap`:
// one in-flight lookup shared by compatible callers, success kept for the
// connection's lifetime (all sources cleared on a `reconnect` status event),
// **every failure a negative cache with a 30 s TTL** (a raced or transient
// answer must not stick). This prevents an unsigned lookup from bypassing a
// later signer's validation. `refreshSelfId()` forces a retry for its source.
//
// Fast-fail: nats-core rejects the pending request the moment the server
// reports a permissions violation — as a `RequestError` whose `.cause` is
// the `PermissionViolationError` (PR-0 finding) — so a denied `$SYS.>`
// costs no timeout. A server without the responder answers 503 →
// `NoRespondersError`, immediate as well.

import {
  Empty,
  NoRespondersError,
  PermissionViolationError,
  RequestError,
  TimeoutError,
  type NatsConnection,
} from "@nats-io/nats-core";
import { utf8ByteLength } from "../bytes.js";
import {
  IdentityError,
  IdentityMismatchError,
  IdentityUnavailableError,
  NoIdentityError,
} from "../errors.js";
import {
  ACCOUNT_LENGTH_ALLOWANCE_BYTES,
  agentIdAccount,
  agentIdUser,
  assertValidAccount,
  isUserKeyShaped,
  newAgentId,
  type AgentId,
} from "./agent-id.js";
import { identityFromJwt, type SenderSigner } from "./signer.js";

export const USER_INFO_SUBJECT = "$SYS.REQ.USER.INFO";
/** Spec default timeout for the `$SYS.REQ.USER.INFO` request. */
export const SELF_ID_TIMEOUT_MS = 2_000;
/** How long a failed lookup is remembered before a retry may run. */
export const SELF_ID_NEGATIVE_TTL_MS = 30_000;

export interface SelfIdOptions {
  /** When set: bind this signer (and its JWT account, when present) to the live connection. */
  readonly signer?: SenderSigner;
  /** `$SYS.REQ.USER.INFO` timeout. Default {@link SELF_ID_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

export type SelfIdSettled = { readonly id: AgentId } | { readonly error: IdentityError };

interface Entry {
  inflight: Promise<AgentId> | null;
  settled: SelfIdSettled | null;
  failedAt: number;
}

interface ConnectionEntries {
  readonly sources: Map<string, Entry>;
  listening: boolean;
}

const memo = new WeakMap<NatsConnection, ConnectionEntries>();

/** Public identity material only; never retain a raw JWT as a cache key. */
function sourceFingerprint(opts: SelfIdOptions): string {
  const signer = opts.signer;
  if (!signer) return "unsigned";
  if (signer.jwt === undefined) return `signer:${signer.publicKey}`;
  try {
    return `signer:${signer.publicKey}:${identityFromJwt(signer.jwt)}`;
  } catch {
    // Fingerprinting is bookkeeping, not validation. Keep it total so a
    // malformed JWT is rejected asynchronously by lookupSelfId() after the
    // live binding request, and never retain the JWT itself in the cache key.
    return `signer:${signer.publicKey}:invalid-jwt`;
  }
}

function entriesFor(nc: NatsConnection): ConnectionEntries {
  let entries = memo.get(nc);
  if (!entries) {
    entries = { sources: new Map(), listening: false };
    memo.set(nc, entries);
  }
  if (!entries.listening) {
    entries.listening = true;
    const current = entries;
    // One status listener per connection; a reconnect may land on a server
    // with a different identity answer, so the memo is cleared. It is never
    // torn down explicitly: `nc.close()` / `drain()` end the status iterator
    // and the loop exits, and the memo entry lives in a `WeakMap` keyed by
    // the connection — so the loop's reference to `current` only outlives a
    // connection that was dropped without ever being closed, which is not
    // a supported shutdown path for `NatsConnection` anyway.
    void (async (): Promise<void> => {
      try {
        for await (const s of nc.status()) {
          if (s.type === "reconnect") {
            current.sources.clear();
          }
        }
      } catch {
        /* connection closed */
      }
    })();
  }
  return entries;
}

function entryFor(nc: NatsConnection, opts: SelfIdOptions): Entry {
  const entries = entriesFor(nc);
  const key = sourceFingerprint(opts);
  let entry = entries.sources.get(key);
  if (!entry) {
    entry = { inflight: null, settled: null, failedAt: 0 };
    entries.sources.set(key, entry);
  }
  return entry;
}

function failureExpired(entry: Entry, now: number): boolean {
  return now - entry.failedAt >= SELF_ID_NEGATIVE_TTL_MS;
}

/**
 * The memoised result, synchronously: the id, a failure still inside its
 * negative-cache TTL, or `undefined` (never looked up, in flight, or an
 * expired failure).
 */
export function peekSelfId(
  nc: NatsConnection,
  opts: SelfIdOptions = {},
): SelfIdSettled | undefined {
  const entry = memo.get(nc)?.sources.get(sourceFingerprint(opts));
  if (!entry?.settled) return undefined;
  if ("error" in entry.settled && failureExpired(entry, Date.now())) return undefined;
  return entry.settled;
}

/** True when the memo holds a failure whose negative-cache TTL has elapsed. */
export function selfIdFailureExpired(nc: NatsConnection, opts: SelfIdOptions = {}): boolean {
  const entry = memo.get(nc)?.sources.get(sourceFingerprint(opts));
  return (
    entry?.settled !== null &&
    entry?.settled !== undefined &&
    "error" in entry.settled &&
    failureExpired(entry, Date.now())
  );
}

/** True while a lookup is in flight on this connection. */
export function isSelfIdInflight(nc: NatsConnection, opts: SelfIdOptions = {}): boolean {
  const inflight = memo.get(nc)?.sources.get(sourceFingerprint(opts))?.inflight;
  return inflight !== null && inflight !== undefined;
}

/**
 * The connection's agent ID. Awaits at most one lookup; repeats the
 * memoised answer (or failure, inside its TTL) afterwards.
 */
export function selfId(nc: NatsConnection, opts: SelfIdOptions = {}): Promise<AgentId> {
  const entry = entryFor(nc, opts);
  if (entry.settled) {
    if ("id" in entry.settled) return Promise.resolve(entry.settled.id);
    if (!failureExpired(entry, Date.now())) return Promise.reject(entry.settled.error);
  }
  return startLookup(nc, entry, opts);
}

/** Force a new lookup, discarding any memoised answer (shares an in-flight one). */
export function refreshSelfId(nc: NatsConnection, opts: SelfIdOptions = {}): Promise<AgentId> {
  const entry = entryFor(nc, opts);
  if (entry.inflight) return entry.inflight;
  entry.settled = null;
  entry.failedAt = 0;
  return startLookup(nc, entry, opts);
}

/** Fire-and-forget: start the lookup if nothing is memoised or in flight. */
export function startSelfIdLookup(nc: NatsConnection, opts: SelfIdOptions = {}): void {
  // The Promise boundary also contains any future synchronous bookkeeping
  // failure: discovery must never be broken by its background warm-up.
  void Promise.resolve()
    .then(() => selfId(nc, opts))
    .catch(() => {});
}

function startLookup(nc: NatsConnection, entry: Entry, opts: SelfIdOptions): Promise<AgentId> {
  if (entry.inflight) return entry.inflight;
  const p = lookupSelfId(nc, opts).then(
    (id) => {
      entry.settled = { id };
      entry.failedAt = 0;
      entry.inflight = null;
      return id;
    },
    (err: unknown) => {
      const error =
        err instanceof IdentityError
          ? err
          : new IdentityUnavailableError(err instanceof Error ? err.message : String(err), {
              cause: err,
            });
      entry.settled = { error };
      entry.failedAt = Date.now();
      entry.inflight = null;
      throw error;
    },
  );
  entry.inflight = p;
  // The rejection is delivered to every awaiting caller; a caller that
  // fired-and-forgot must not leave it unhandled.
  p.catch(() => {});
  return p;
}

/**
 * One uncached lookup: always ask the live connection via
 * `$SYS.REQ.USER.INFO`. A configured signer must match the resolved user;
 * when it carries a JWT, both its user and account must equal the live
 * answer. Disagreement fails and is not memoised as a success.
 */
export async function lookupSelfId(nc: NatsConnection, opts: SelfIdOptions = {}): Promise<AgentId> {
  const signer = opts.signer;
  const liveId = await requestUserInfo(nc, opts.timeoutMs ?? SELF_ID_TIMEOUT_MS);
  if (signer && agentIdUser(liveId) !== signer.publicKey) {
    throw new IdentityMismatchError(signer.publicKey, agentIdUser(liveId));
  }
  if (signer?.jwt !== undefined) {
    const signerId = identityFromJwt(signer.jwt);
    if (agentIdUser(signerId) !== signer.publicKey) {
      throw new IdentityMismatchError(
        signer.publicKey,
        agentIdUser(liveId),
        undefined,
        undefined,
        agentIdUser(signerId),
      );
    }
    if (signerId !== liveId) {
      throw new IdentityMismatchError(
        signer.publicKey,
        agentIdUser(liveId),
        agentIdAccount(signerId),
        agentIdAccount(liveId),
      );
    }
  }
  return liveId;
}

async function requestUserInfo(nc: NatsConnection, timeoutMs: number): Promise<AgentId> {
  let data: Uint8Array;
  try {
    data = (await nc.request(USER_INFO_SUBJECT, Empty, { timeout: timeoutMs })).data;
  } catch (err) {
    throw mapRequestError(err, timeoutMs);
  }
  let reply: unknown;
  try {
    reply = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new IdentityUnavailableError(`${USER_INFO_SUBJECT} reply is not JSON`);
  }
  return identityFromUserInfoReply(reply);
}

function mapRequestError(err: unknown, timeoutMs: number): IdentityError {
  const cause = err instanceof RequestError ? err.cause : err;
  if (cause instanceof PermissionViolationError) {
    return new IdentityUnavailableError(
      `publish to ${USER_INFO_SUBJECT} is a permissions violation for this user`,
      { cause: err },
    );
  }
  if (cause instanceof NoRespondersError || (err instanceof RequestError && err.isNoResponders())) {
    return new IdentityUnavailableError(
      `no responder for ${USER_INFO_SUBJECT} (server without the system responder?)`,
      {
        cause: err,
      },
    );
  }
  if (cause instanceof TimeoutError || err instanceof TimeoutError) {
    return new IdentityUnavailableError(
      `no reply from ${USER_INFO_SUBJECT} within ${timeoutMs} ms`,
      {
        cause: err,
      },
    );
  }
  return new IdentityUnavailableError(
    `${USER_INFO_SUBJECT} request failed: ${err instanceof Error ? err.message : String(err)}`,
    { cause: err },
  );
}

/**
 * Derive the agent ID from a parsed `$SYS.REQ.USER.INFO` reply
 * (`{ data: { user, account, ... } }`). Unknown fields (`account_name`,
 * `permissions`, `expires`) are ignored. `NoIdentityError` when the
 * connection has no NKEY user or the account name is not representable;
 * `IdentityUnavailableError` when the reply is not the expected shape.
 */
export function identityFromUserInfoReply(reply: unknown): AgentId {
  if (typeof reply !== "object" || reply === null || Array.isArray(reply)) {
    throw new IdentityUnavailableError(`${USER_INFO_SUBJECT} reply is not a JSON object`);
  }
  const r = reply as Record<string, unknown>;
  if (r["error"] !== undefined) {
    throw new IdentityUnavailableError(
      `${USER_INFO_SUBJECT} answered with an error: ${JSON.stringify(r["error"])}`,
    );
  }
  const data = r["data"];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new IdentityUnavailableError(`${USER_INFO_SUBJECT} reply has no \`data\` object`);
  }
  const d = data as Record<string, unknown>;
  const user = d["user"];
  const account = d["account"];
  if (typeof user !== "string" || typeof account !== "string") {
    throw new IdentityUnavailableError(
      `${USER_INFO_SUBJECT} reply lacks string \`user\` / \`account\``,
    );
  }
  if (user.length === 0)
    throw new NoIdentityError("no authentication — the server reports an empty user");
  if (user === "[REDACTED]")
    throw new NoIdentityError("token authentication — the server reports a redacted user");
  if (!isUserKeyShaped(user)) {
    throw new NoIdentityError(
      `password authentication — the server reports the user name ${JSON.stringify(user)}, not an NKEY`,
    );
  }
  if (utf8ByteLength(account) > ACCOUNT_LENGTH_ALLOWANCE_BYTES) {
    throw new NoIdentityError(
      `the account name is longer than ${ACCOUNT_LENGTH_ALLOWANCE_BYTES} bytes and cannot be carried by the agent-ID form`,
    );
  }
  try {
    assertValidAccount(account);
  } catch (err) {
    throw new NoIdentityError(
      `the account name ${JSON.stringify(account)} cannot be carried by the agent-ID form (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return newAgentId(account, user);
}

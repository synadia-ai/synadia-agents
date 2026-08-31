// The `Agent-Sender` header: the one shared codec (build, serialise, parse,
// sign, verify) used by both the caller package and the host package.
//
//   Agent-Sender: {"v":1,"account":"A…","user":"U…","name":"…","sub":"…","ts":"…","nonce":"…","sig":"…"}
//
// Serialisation is canonical and byte-equal across languages: fields in
// the order `v, account, user, name?, sub?, ts?, nonce?, sig?` (absent ones
// omitted), compact separators, non-ASCII raw, `v` the integer 1. A parsed
// header is never re-serialised; the signed input is rebuilt from fields.
//
// Signed input (never sent):
//   AGENT-SENDER-V1\n{account}\n{user}\n{subject}\n{ts}\n{nonce}\n{sha256(payload) hex}\n
//
// The parser is hardened per the plan (§2.2): a violation is
// `MalformedSenderHeaderError` (→ `400` at the receiver); an unknown `v`
// makes the header count as absent (`null`).

import { nuid, type MsgHdrs } from "@nats-io/nats-core";
import { utf8ByteLength } from "../bytes.js";
import {
  IdentityError,
  InvalidAgentIdError,
  MalformedSenderHeaderError,
  SenderVerificationError,
} from "../errors.js";
import type { AgentInfo } from "../discovery/agent-info.js";
import { ACCOUNT_LENGTH_ALLOWANCE_BYTES, newAgentId, type AgentId } from "./agent-id.js";
import {
  base64UrlDecode,
  base64UrlEncode,
  sha256Hex,
  utf8,
  verifyWithPublicKey,
} from "./crypto.js";
import { readRequestInfo } from "./request-info.js";
import type { SenderSigner } from "./signer.js";

/** The header name — matched case-sensitively. */
export const AGENT_SENDER_HEADER = "Agent-Sender";
/** The header format version this SDK implements. */
export const AGENT_SENDER_VERSION = 1;
/** First line of the signed input. */
export const AGENT_SENDER_SIGNED_INPUT_TAG = "AGENT-SENDER-V1";
/** Header value length cap applied before JSON parsing. */
export const MAX_SENDER_HEADER_VALUE_BYTES = 2048;
/** Display-name cap (UTF-16 code units) — an SDK rule, not a wire rule. */
export const MAX_SENDER_NAME_LENGTH = 64;
/** Default replay window / `ts` skew (spec: 30 s). */
export const DEFAULT_REPLAY_WINDOW_MS = 30_000;
/** `NATS/1.0\r\nAgent-Sender: ` + `\r\n\r\n` — the framing the server counts against `max_payload`. */
export const SENDER_HEADER_FRAMING_BYTES = 28;
/** Generic wire description for every refusal except a missing required signature. */
export const SENDER_REJECTED_DESCRIPTION = "sender rejected";
/** Wire description when `min_sender_trust: signed` and the request is not verified. */
export const SIGNATURE_REQUIRED_DESCRIPTION = "signature required";

const TS_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const NONCE_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
// Subject shape: non-empty tokens separated by `.`, no whitespace / control chars.
const SUBJECT_REGEX = /^[^\s.\x00-\x1f\x7f]+(\.[^\s.\x00-\x1f\x7f]+)*$/;
const SIGNATURE_BYTES = 64;
const SIGNATURE_B64URL_LENGTH = 86;
const TS_LENGTH = 20; // YYYY-MM-DDTHH:MM:SSZ
const NUID_LENGTH = 22;
const MAX_NONCE_LENGTH = 64;
const USER_KEY_LENGTH = 56;

/** A parsed (or built) `Agent-Sender` header. Only the known fields. */
export interface AgentSenderHeader {
  readonly v: 1;
  readonly account: string;
  readonly user: string;
  readonly name?: string;
  readonly sub?: string;
  readonly ts?: string;
  readonly nonce?: string;
  readonly sig?: string;
}

/** A sender whose signature verified: `user` is proven, `account` is the signed claim. */
export interface VerifiedSender {
  readonly trust: "verified";
  readonly id: AgentId;
  /**
   * `true` only when the receiver runs in operator-attested mode
   * (`operatorAttested: true` — the deployment declared the endpoint
   * closed, spec Appendix A) **and** a server stamp agreed with the
   * signed `account`: the `Nats-Request-Info` `acc`, or the token an
   * `account_token_position` export inserted. Otherwise `account` is the
   * sender's signed word next to a verified `user`.
   */
  readonly accountAttested: boolean;
  readonly name?: string;
  readonly header: AgentSenderHeader;
  /**
   * Reverse lookup (spec "Reverse lookup"): the verified `AgentInfo`
   * registered under this agent ID, via the resolver the host bound
   * (`resolveTtlMs` on the host options). `undefined` when unbound or when
   * no verified instance claims the key.
   */
  readonly resolve: () => Promise<AgentInfo | undefined>;
}

/** An unsigned claim — display-grade. Deliberately has no `id`. */
export interface ClaimedSender {
  readonly trust: "claimed";
  readonly claim: { readonly account: string; readonly user: string };
  readonly name?: string;
  readonly header: AgentSenderHeader;
}

export type SenderInfo = VerifiedSender | ClaimedSender;

// ---------------------------------------------------------------------------
// Display name validation (shared by the option validator and the parser).
// ---------------------------------------------------------------------------

/**
 * `name` rules: ≤ 64 UTF-16 code units, no C0 / C1 / DEL / U+2028 / U+2029,
 * no lone surrogates. Throws `IdentityError`; the message never includes
 * the name.
 */
export function assertValidSenderName(name: string): void {
  if (name.length > MAX_SENDER_NAME_LENGTH) {
    throw new IdentityError(`identity.name exceeds ${MAX_SENDER_NAME_LENGTH} UTF-16 code units`);
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) {
      throw new IdentityError("identity.name contains a control character");
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < name.length ? name.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        throw new IdentityError("identity.name contains a lone surrogate");
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new IdentityError("identity.name contains a lone surrogate");
    }
  }
}

function isValidSenderName(name: string): boolean {
  try {
    assertValidSenderName(name);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** Canonical single-line JSON (field order fixed, absent fields omitted). */
export function serializeSenderHeader(h: AgentSenderHeader): string {
  const o: Record<string, unknown> = { v: AGENT_SENDER_VERSION, account: h.account, user: h.user };
  if (h.name !== undefined) o["name"] = h.name;
  if (h.sub !== undefined) o["sub"] = h.sub;
  if (h.ts !== undefined) o["ts"] = h.ts;
  if (h.nonce !== undefined) o["nonce"] = h.nonce;
  if (h.sig !== undefined) o["sig"] = h.sig;
  return JSON.stringify(o);
}

/** Wire length of the header including NATS header framing (28 bytes + the value). */
export function encodedHeaderLength(value: string): number {
  return SENDER_HEADER_FRAMING_BYTES + utf8ByteLength(value);
}

/**
 * Sound upper bound on the framed size of any header this SDK would send
 * for `subject` / `name`: real lengths for the subject and the name, the
 * fixed field widths (`user` 56, `ts` 20, `nonce` ≤ 64, `sig` 86), a
 * 64-byte `account` allowance, JSON overhead, and the 28 framing bytes.
 */
export function maxSenderHeaderBytes(subject: string, name?: string): number {
  const template: AgentSenderHeader = {
    v: 1,
    account: "A".repeat(ACCOUNT_LENGTH_ALLOWANCE_BYTES),
    user: "U".repeat(USER_KEY_LENGTH),
    ...(name !== undefined ? { name } : {}),
    sub: subject,
    ts: "T".repeat(TS_LENGTH),
    nonce: "N".repeat(MAX_NONCE_LENGTH),
    sig: "S".repeat(SIGNATURE_B64URL_LENGTH),
  };
  return encodedHeaderLength(serializeSenderHeader(template));
}

/**
 * Exact framed size of the header the SDK will send for a known identity:
 * every field this SDK emits has a fixed width except `account`, `user`,
 * `name` and `sub`, which are known before signing.
 */
export function expectedSenderHeaderBytes(opts: {
  readonly id: AgentId;
  readonly name?: string;
  readonly sub: string;
  readonly signed: boolean;
}): number {
  const dot = opts.id.indexOf(".");
  const base: AgentSenderHeader = {
    v: 1,
    account: opts.id.slice(0, dot),
    user: opts.id.slice(dot + 1),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  };
  const header: AgentSenderHeader = opts.signed
    ? {
        ...base,
        sub: opts.sub,
        ts: "T".repeat(TS_LENGTH),
        nonce: "N".repeat(NUID_LENGTH),
        sig: "S".repeat(SIGNATURE_B64URL_LENGTH),
      }
    : base;
  return encodedHeaderLength(serializeSenderHeader(header));
}

// ---------------------------------------------------------------------------
// Parsing (hardened)
// ---------------------------------------------------------------------------

/**
 * Read the raw `Agent-Sender` value from message headers. Exact-case match;
 * `undefined` when absent (including a differently-cased name); more than
 * one value → `MalformedSenderHeaderError`.
 */
export function readSenderHeaderValue(headers: MsgHdrs | undefined): string | undefined {
  if (!headers) return undefined;
  const values = headers.values(AGENT_SENDER_HEADER);
  if (values.length === 0) return undefined;
  if (values.length > 1) throw new MalformedSenderHeaderError("more than one Agent-Sender value");
  return values[0];
}

/**
 * Parse a header value. Returns `null` for a well-formed header with an
 * unknown `v` (the receiver treats it as absent). Throws
 * `MalformedSenderHeaderError` for everything the spec calls malformed and
 * for the plan's hardening rules (§2.2).
 */
export function parseSenderHeader(value: string): AgentSenderHeader | null {
  if (utf8ByteLength(value) > MAX_SENDER_HEADER_VALUE_BYTES) {
    throw new MalformedSenderHeaderError(`value exceeds ${MAX_SENDER_HEADER_VALUE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MalformedSenderHeaderError("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MalformedSenderHeaderError("not a JSON object");
  }
  const o = parsed as Record<string, unknown>;

  const v = o["v"];
  if (typeof v !== "number") throw new MalformedSenderHeaderError("`v` must be a JSON number");
  if (v !== AGENT_SENDER_VERSION) return null;

  const account = o["account"];
  const user = o["user"];
  if (typeof account !== "string" || typeof user !== "string") {
    throw new MalformedSenderHeaderError("`account` and `user` must be strings");
  }
  try {
    newAgentId(account, user);
  } catch (err) {
    if (err instanceof InvalidAgentIdError) throw new MalformedSenderHeaderError(err.message);
    throw err;
  }

  const out: {
    v: 1;
    account: string;
    user: string;
    name?: string;
    sub?: string;
    ts?: string;
    nonce?: string;
    sig?: string;
  } = { v: 1, account, user };

  const name = o["name"];
  if (name !== undefined) {
    if (typeof name !== "string" || !isValidSenderName(name)) {
      throw new MalformedSenderHeaderError("`name` is not a valid display name");
    }
    out.name = name;
  }
  const sub = o["sub"];
  if (sub !== undefined) {
    if (typeof sub !== "string" || !SUBJECT_REGEX.test(sub)) {
      throw new MalformedSenderHeaderError("`sub` is not a NATS subject");
    }
    out.sub = sub;
  }
  const ts = o["ts"];
  if (ts !== undefined) {
    if (typeof ts !== "string" || !TS_REGEX.test(ts) || Number.isNaN(Date.parse(ts))) {
      throw new MalformedSenderHeaderError("`ts` is not an RFC 3339 UTC timestamp");
    }
    out.ts = ts;
  }
  const nonce = o["nonce"];
  if (nonce !== undefined) {
    if (typeof nonce !== "string" || !NONCE_REGEX.test(nonce)) {
      throw new MalformedSenderHeaderError("`nonce` must match [A-Za-z0-9_-]{1,64}");
    }
    out.nonce = nonce;
  }
  const sig = o["sig"];
  if (sig !== undefined) {
    if (typeof sig !== "string") throw new MalformedSenderHeaderError("`sig` must be a string");
    let bytes: Uint8Array;
    try {
      bytes = base64UrlDecode(sig);
    } catch {
      throw new MalformedSenderHeaderError("`sig` is not base64url");
    }
    if (bytes.length !== SIGNATURE_BYTES) {
      throw new MalformedSenderHeaderError("`sig` must decode to 64 bytes");
    }
    if (out.sub === undefined || out.ts === undefined || out.nonce === undefined) {
      throw new MalformedSenderHeaderError("`sig` requires `sub`, `ts` and `nonce`");
    }
    out.sig = sig;
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/** `YYYY-MM-DDTHH:MM:SSZ` — second precision, `Z` suffix. */
export function formatSenderTimestamp(ms: number = Date.now()): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Milliseconds since the epoch of a header `ts` (validated by the parser). */
export function parseSenderTimestamp(ts: string): number {
  return Date.parse(ts);
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface SignedInputFields {
  readonly account: string;
  readonly user: string;
  readonly subject: string;
  readonly ts: string;
  readonly nonce: string;
  /** Lowercase hex SHA-256 of the payload. */
  readonly payloadSha256Hex: string;
}

/** The exact bytes that are signed (never sent). */
export function buildSignedInput(f: SignedInputFields): Uint8Array {
  return utf8.encode(
    `${AGENT_SENDER_SIGNED_INPUT_TAG}\n${f.account}\n${f.user}\n${f.subject}\n${f.ts}\n${f.nonce}\n${f.payloadSha256Hex}\n`,
  );
}

export interface SignSenderHeaderOptions {
  readonly signer: SenderSigner;
  readonly id: AgentId;
  readonly name?: string;
  /** The subject to sign — what the caller publishes to (or the exporter's subject behind a rename). */
  readonly sub: string;
  readonly payload: Uint8Array;
  /** Override for tests / vectors; default: now, second precision. */
  readonly ts?: string;
  /** Override for tests / vectors; default: a fresh NUID. */
  readonly nonce?: string;
}

/** Build and sign a header. `ts` and `nonce` are fresh unless overridden. */
export async function signSenderHeader(opts: SignSenderHeaderOptions): Promise<AgentSenderHeader> {
  const dot = opts.id.indexOf(".");
  const account = opts.id.slice(0, dot);
  const user = opts.id.slice(dot + 1);
  const ts = opts.ts ?? formatSenderTimestamp();
  const nonce = opts.nonce ?? nuid.next();
  const input = buildSignedInput({
    account,
    user,
    subject: opts.sub,
    ts,
    nonce,
    payloadSha256Hex: await sha256Hex(opts.payload),
  });
  const sig = base64UrlEncode(await opts.signer.sign(input));
  return Object.freeze({
    v: 1 as const,
    account,
    user,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    sub: opts.sub,
    ts,
    nonce,
    sig,
  });
}

/** An unsigned claim: exactly `v, account, user, name?`. */
export function buildClaimHeader(opts: {
  readonly id: AgentId;
  readonly name?: string;
}): AgentSenderHeader {
  const dot = opts.id.indexOf(".");
  return Object.freeze({
    v: 1 as const,
    account: opts.id.slice(0, dot),
    user: opts.id.slice(dot + 1),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifySenderOptions {
  /**
   * `live`: freshness checks run (`ts` window; the caller-supplied nonce
   * lookup). `stored`: identity only — for JetStream consumers, which
   * dedupe on `(user, nonce)` themselves.
   */
  readonly mode: "live" | "stored";
  /**
   * 1-based position of the caller's account token the server inserted
   * into the arrival subject (`account_token_position` on the export).
   * With it set, the token at that position MUST equal the header's
   * `account`, and `sub` is accepted either as the arrival subject or as
   * the arrival subject with that token removed.
   */
  readonly accountTokenPosition?: number;
  /** `ts` skew tolerated in `live` mode. Default 30 000. */
  readonly replayWindowMs?: number;
  /** Clock override (ms) for `live` mode. */
  readonly now?: number;
  /**
   * `live` mode: consulted after the cheap checks and before the
   * signature; `true` means the `(user, nonce)` pair was already seen.
   * Recording a nonce is the caller's job, after every check passed.
   */
  readonly nonceSeen?: (user: string, nonce: string) => boolean;
  /** Reverse-lookup binding for the returned `VerifiedSender.resolve()`. */
  readonly resolver?: (id: AgentId) => Promise<AgentInfo | undefined>;
  /**
   * Operator-attested mode (spec Appendix A) — **off by default**, and a
   * deployment promise the SDK cannot verify: every request reaching
   * this receiver crossed a service import, so `Nats-Request-Info` (and
   * an inserted account token) is the server's stamp, never a peer's
   * forgery. With it on, a signed header is cross-checked against the
   * stamp in `headers`: a present `acc` must equal the signed `account`
   * and a present `user` (a `share: true` import) the signed `user`;
   * disagreement, or a stamp the server would not write, → `401`. A
   * missing stamp is compared to nothing. Agreement on `acc` — or the
   * `accountTokenPosition` cross-check — sets `accountAttested`.
   * Unsigned claims are never cross-checked.
   */
  readonly operatorAttested?: boolean;
  /** The message headers; consulted only under `operatorAttested` for `Nats-Request-Info`. */
  readonly headers?: MsgHdrs | undefined;
}

/** The structural message shape `verifySender` takes (`Msg`, `ServiceMsg`, `JsMsg` all fit). */
export interface VerifiableMsg {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly headers?: MsgHdrs | undefined;
}

/** {@link VerifySenderOptions} without what `verifySender` supplies itself. */
export type VerifySenderMsgOptions = Omit<VerifySenderOptions, "mode" | "headers">;

/** Validate `accountTokenPosition`; returns it or `undefined`. */
export function normalizeAccountTokenPosition(p: number | undefined): number | undefined {
  if (p === undefined) return undefined;
  if (!Number.isInteger(p) || p < 1) {
    throw new IdentityError("accountTokenPosition must be an integer >= 1 (1-based)");
  }
  return p;
}

/**
 * `sub` acceptance against the arrival subject — never against a pattern.
 * Returns a rejection detail, or `null` when accepted.
 */
export function checkSubjectAcceptance(
  header: { readonly account: string; readonly sub: string },
  arrivalSubject: string,
  accountTokenPosition: number | undefined,
): string | null {
  if (accountTokenPosition === undefined) {
    return header.sub === arrivalSubject
      ? null
      : `sub ${JSON.stringify(header.sub)} is not the arrival subject ${JSON.stringify(arrivalSubject)}`;
  }
  const tokens = arrivalSubject.split(".");
  if (accountTokenPosition > tokens.length) {
    return `accountTokenPosition ${accountTokenPosition} is beyond the ${tokens.length}-token arrival subject`;
  }
  const inserted = tokens[accountTokenPosition - 1];
  if (inserted !== header.account) {
    return `arrival subject token ${JSON.stringify(inserted)} at position ${accountTokenPosition} is not the header account ${JSON.stringify(header.account)}`;
  }
  const stripped = [
    ...tokens.slice(0, accountTokenPosition - 1),
    ...tokens.slice(accountTokenPosition),
  ].join(".");
  if (header.sub === arrivalSubject || header.sub === stripped) return null;
  return `sub ${JSON.stringify(header.sub)} is neither the arrival subject ${JSON.stringify(arrivalSubject)} nor ${JSON.stringify(stripped)}`;
}

function reject(detail: string): never {
  throw new SenderVerificationError(401, SENDER_REJECTED_DESCRIPTION, detail);
}

/**
 * Verify a parsed header against the message it arrived with. Check order
 * (cheap first; the wire outcome is `401` either way): `ts` window (live)
 * → `sub` acceptance → nonce lookup (live, via `opts.nonceSeen`) →
 * ed25519. The nonce lookup deliberately precedes the signature so a
 * replay — or a forgery reusing a seen nonce — costs no sha256/ed25519.
 * An unsigned header yields a `ClaimedSender` without any check.
 *
 * **A returned `VerifiedSender` does not mean the nonce was recorded.**
 * This function only *looks up* nonces; the receiver records the nonce
 * (check-and-set) after every other admission step passed — see the host
 * package's `SenderGate.admitPrompt()`. A caller that skips recording has
 * no replay protection.
 *
 * Throws `SenderVerificationError` (`.code === 401`) on a failing check.
 */
export async function verifySenderHeader(
  header: AgentSenderHeader,
  arrivalSubject: string,
  payload: Uint8Array,
  opts: VerifySenderOptions,
): Promise<SenderInfo> {
  if (
    header.sig === undefined ||
    header.sub === undefined ||
    header.ts === undefined ||
    header.nonce === undefined
  ) {
    return Object.freeze({
      trust: "claimed" as const,
      claim: Object.freeze({ account: header.account, user: header.user }),
      ...(header.name !== undefined ? { name: header.name } : {}),
      header,
    });
  }
  const accountTokenPosition = normalizeAccountTokenPosition(opts.accountTokenPosition);

  if (opts.mode === "live") {
    const window = opts.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    const now = opts.now ?? Date.now();
    const skew = Math.abs(now - parseSenderTimestamp(header.ts));
    if (skew > window)
      reject(`ts ${header.ts} is ${Math.round(skew / 1000)} s from now (window ${window} ms)`);
  }

  const subjectProblem = checkSubjectAcceptance(
    { account: header.account, sub: header.sub },
    arrivalSubject,
    accountTokenPosition,
  );
  if (subjectProblem !== null) reject(subjectProblem);

  // Operator-attested cross-check (cheap; before the nonce lookup and the
  // signature, same 401 outcome). Only here is `Nats-Request-Info` ever read.
  let accountAttested = false;
  if (opts.operatorAttested) {
    const stamp = readRequestInfo(opts.headers);
    if (stamp === null) {
      reject("Nats-Request-Info is present but is not a server stamp (operator-attested mode)");
    }
    if (stamp !== undefined) {
      if (stamp.account !== undefined && stamp.account !== header.account) {
        reject(
          `Nats-Request-Info acc ${JSON.stringify(stamp.account)} disagrees with the signed account ${JSON.stringify(header.account)}`,
        );
      }
      if (stamp.user !== undefined && stamp.user !== header.user) {
        reject(
          `Nats-Request-Info user ${JSON.stringify(stamp.user)} disagrees with the signed user ${header.user}`,
        );
      }
    }
    accountAttested = accountTokenPosition !== undefined || stamp?.account !== undefined;
  }

  if (opts.mode === "live" && opts.nonceSeen?.(header.user, header.nonce)) {
    reject(`nonce already seen for ${header.user}`);
  }

  const input = buildSignedInput({
    account: header.account,
    user: header.user,
    subject: header.sub,
    ts: header.ts,
    nonce: header.nonce,
    payloadSha256Hex: await sha256Hex(payload),
  });
  if (!verifyWithPublicKey(header.user, input, base64UrlDecode(header.sig))) {
    reject(`signature does not verify for ${header.user}`);
  }

  const id = newAgentId(header.account, header.user);
  const resolver = opts.resolver;
  return Object.freeze({
    trust: "verified" as const,
    id,
    accountAttested,
    ...(header.name !== undefined ? { name: header.name } : {}),
    header,
    resolve: resolver
      ? (): Promise<AgentInfo | undefined> => resolver(id)
      : (): Promise<undefined> => Promise.resolve(undefined),
  });
}

/**
 * The spec's `VerifySender(msg, mode)` over a structural message: reads
 * and parses `Agent-Sender` from `msg.headers`, then applies
 * {@link verifySenderHeader} with `msg.subject` as the arrival subject
 * (the stored subject for a JetStream record) and `msg.data` as the
 * payload. `undefined` when the message carries no `Agent-Sender` or one
 * with an unknown `v`. Throws `MalformedSenderHeaderError` (→ `400`) and
 * `SenderVerificationError` (`.code` `401`) like the underlying function;
 * a nonce is only *looked up* here, never recorded.
 *
 * `live` for a request being served now; `stored` for a JetStream
 * consumer (freshness skipped — dedupe on `(user, nonce)` yourself).
 */
export async function verifySender(
  msg: VerifiableMsg,
  mode: "live" | "stored",
  opts: VerifySenderMsgOptions = {},
): Promise<SenderInfo | undefined> {
  const value = readSenderHeaderValue(msg.headers);
  if (value === undefined) return undefined;
  const header = parseSenderHeader(value);
  if (header === null) return undefined;
  return verifySenderHeader(header, msg.subject, msg.data, {
    ...opts,
    mode,
    headers: msg.headers,
  });
}

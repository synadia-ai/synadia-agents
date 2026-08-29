// The agent ID — `{account}.{user}` — as a branded string (spec
// "Canonical text form"). **This module is the only code that builds or
// splits the text form**: host registration metadata, header parsing and
// the reverse-lookup index all go through `newAgentId` / `parseAgentId`.
//
//   account  the account as `$SYS.REQ.USER.INFO` reports it — the account
//            public NKEY (`A…`, 56 chars) on an operator-mode server, else
//            a config-file account name matching `[A-Za-z0-9_-]+` or `$G`
//   user     the user public NKEY (`U…`, 56 chars)
//
// The regex is the shape check; the nkeys library check (prefix byte +
// CRC) runs on `user` always and on `account` whenever it has the NKEY
// shape (starts with `A`, 56 characters — spec wording). Equality is
// string equality, so `===` and `Map`/`Set` keys work with no extra code.

import { fromPublic } from "@nats-io/nkeys";
import { InvalidAgentIdError } from "../errors.js";

declare const agentIdBrand: unique symbol;

/** A validated `{account}.{user}` agent ID. Compare with `===`. */
export type AgentId = string & { readonly [agentIdBrand]: true };

/** Spec regex — the shape check for the canonical text form. */
export const AGENT_ID_REGEX = /^(A[A-Z2-7]{55}|[A-Za-z0-9_-]+|\$G)\.U[A-Z2-7]{55}$/;

const USER_KEY_REGEX = /^U[A-Z2-7]{55}$/;
const ACCOUNT_NAME_REGEX = /^([A-Za-z0-9_-]+|\$G)$/;
const NKEY_PUBLIC_LENGTH = 56;
/** Size-bound allowance for `account` in UTF-8 bytes (56 for an NKEY); longer config-mode names are unrepresentable. */
export const ACCOUNT_LENGTH_ALLOWANCE_BYTES = 64;

/** True iff `user` has the shape of a user public NKEY (`U…`, 56 base32 chars). */
export function isUserKeyShaped(user: string): boolean {
  return USER_KEY_REGEX.test(user);
}

/** True iff `account` has the shape of an account public NKEY (`A…`, 56 chars). */
export function isAccountKeyShaped(account: string): boolean {
  return account.length === NKEY_PUBLIC_LENGTH && account.startsWith("A");
}

function assertValidNkey(kind: "user" | "account", key: string): void {
  try {
    fromPublic(key);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new InvalidAgentIdError(`${kind} key fails the nkeys check (${reason})`);
  }
}

/** Validate `user` as a user public NKEY (shape + nkeys prefix/CRC). */
export function assertValidUserKey(user: string): void {
  if (user.length === 0) throw new InvalidAgentIdError("empty user token");
  if (!USER_KEY_REGEX.test(user)) {
    throw new InvalidAgentIdError("user token is not a user public NKEY (U + 55 base32 chars)");
  }
  assertValidNkey("user", user);
}

/** Validate `account` as an account public NKEY or a representable config-mode name. */
export function assertValidAccount(account: string): void {
  if (account.length === 0) throw new InvalidAgentIdError("empty account token");
  if (isAccountKeyShaped(account)) {
    assertValidNkey("account", account);
    return;
  }
  if (!ACCOUNT_NAME_REGEX.test(account)) {
    throw new InvalidAgentIdError(
      "account token is neither an account public NKEY nor a subject-safe name ([A-Za-z0-9_-]+ or $G)",
    );
  }
}

/**
 * The only constructor. Validates both tokens and fails loud otherwise;
 * there is no zero agent ID (empty tokens are rejected).
 */
export function newAgentId(account: string, user: string): AgentId {
  assertValidAccount(account);
  assertValidUserKey(user);
  return `${account}.${user}` as AgentId;
}

/** The only way from text to an ID. Accepts the canonical form and nothing else. */
export function parseAgentId(text: string): AgentId {
  if (text.length === 0) throw new InvalidAgentIdError("empty string");
  if (!AGENT_ID_REGEX.test(text)) {
    throw new InvalidAgentIdError("expected {account}.{user} with a U… user public NKEY");
  }
  const dot = text.indexOf(".");
  return newAgentId(text.slice(0, dot), text.slice(dot + 1));
}

/** The `account` token of a validated agent ID. */
export function agentIdAccount(id: AgentId): string {
  return id.slice(0, id.indexOf("."));
}

/** The `user` token (the user public NKEY) of a validated agent ID. */
export function agentIdUser(id: AgentId): string {
  return id.slice(id.indexOf(".") + 1);
}

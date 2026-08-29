// Signing capability for the sender-identity extension.
//
// Both SDKs take a pre-opened connection and never see its credentials, so
// the seed is handed in explicitly through a `SenderSigner`. The built-in
// implementation wraps an `@nats-io/nkeys` user key pair; users with an
// HSM / KMS implement the interface themselves (`sign` may be async).
//
// Key hygiene: the key pair lives in a private field, is redacted from
// `JSON.stringify` and `util.inspect`, the seed text is not retained, and
// `wipe()` clears the pair. Error messages never include input text —
// public keys and line numbers only.
//
// No `@nats-io/jwt`: creds files and JWT payloads are parsed by hand (the
// `-----BEGIN NATS USER JWT-----` / `-----BEGIN USER NKEY SEED-----` blocks,
// and a base64url JSON payload decode — no signature check, the server
// already authenticated the JWT).

import { readFile } from "node:fs/promises";
import { fromSeed, type KeyPair } from "@nats-io/nkeys";
import { expandHome, readAuthFile, readContextFile } from "../context.js";
import { IdentityError, IdentityMismatchError, IdentityUnavailableError } from "../errors.js";
import { agentIdUser, newAgentId, type AgentId } from "./agent-id.js";
import { base64UrlDecode, utf8 } from "./crypto.js";

/** Something that can sign with the connection's user NKEY seed. */
export interface SenderSigner {
  /** The user public NKEY (`U…`) this signer signs for. */
  readonly publicKey: string;
  /**
   * The user JWT, when the signer came from a credentials file. `selfId()`
   * reads the agent ID from it (no network, not spoofable by peers).
   */
  readonly jwt?: string;
  /** ed25519 signature over `data`. May be async (HSM / KMS signers). */
  sign(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** Clear the key material; later `sign()` calls fail. Optional for custom signers. */
  wipe?(): void;
}

const USER_SEED_REGEX = /^SU[A-Z2-7]{56}$/;
const JWT_REGEX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const BEGIN_JWT_REGEX = /^-+BEGIN NATS USER JWT-+$/;
const BEGIN_SEED_REGEX = /^-+BEGIN USER NKEY SEED-+$/;

class NkeySigner implements SenderSigner {
  #kp: KeyPair | null;
  readonly publicKey: string;
  readonly jwt?: string;

  constructor(kp: KeyPair, jwt: string | undefined) {
    this.#kp = kp;
    this.publicKey = kp.getPublicKey();
    if (jwt !== undefined) this.jwt = jwt;
  }

  sign(data: Uint8Array): Uint8Array {
    if (this.#kp === null) throw new IdentityError("signer has been wiped");
    return this.#kp.sign(data);
  }

  wipe(): void {
    this.#kp?.clear();
    this.#kp = null;
  }

  toJSON(): { publicKey: string } {
    return { publicKey: this.publicKey };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SenderSigner(${this.publicKey})`;
  }

  toString(): string {
    return `SenderSigner(${this.publicKey})`;
  }
}

/**
 * Build a signer from a user seed (`SU…`), given as text or bytes.
 * Surrounding whitespace (a trailing newline from a seed file) is ignored,
 * and a `-----BEGIN USER NKEY SEED-----` block is accepted too. The seed
 * is not retained; the message of a rejection never includes it.
 */
export function signerFromSeed(seed: string | Uint8Array, jwt?: string): SenderSigner {
  const text = typeof seed === "string" ? seed : utf8.decode(seed);
  const line = text.includes("BEGIN")
    ? extractBlock(text, BEGIN_SEED_REGEX, "USER NKEY SEED")
    : text.trim();
  if (!USER_SEED_REGEX.test(line)) {
    throw new IdentityError("invalid nkey seed: expected a user seed (SU + 56 base32 characters)");
  }
  // `fromSeed` keeps this buffer by reference and decodes it lazily on
  // every `sign()` / `getPublicKey()` — so it must be a private copy
  // (`utf8.encode` allocates one) and must NOT be zeroed here; `wipe()`
  // → `kp.clear()` is what zeroes it.
  let kp: KeyPair;
  try {
    kp = fromSeed(utf8.encode(line));
  } catch (err) {
    throw new IdentityError(
      `invalid nkey seed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const publicKey = kp.getPublicKey();
  if (!publicKey.startsWith("U")) {
    kp.clear();
    throw new IdentityError(
      `seed is not a user seed (derives ${publicKey.slice(0, 1)}… public key)`,
    );
  }
  return new NkeySigner(kp, jwt);
}

/** The two blocks of a credentials file. */
export interface ParsedCreds {
  readonly jwt: string;
  readonly seed: string;
}

/**
 * Hand-rolled `.creds` parser: the line after `-----BEGIN NATS USER JWT-----`
 * is the JWT, the line after `-----BEGIN USER NKEY SEED-----` is the seed.
 * Error messages carry line numbers, never content.
 */
export function parseCreds(text: string): ParsedCreds {
  const jwt = extractBlock(text, BEGIN_JWT_REGEX, "NATS USER JWT");
  if (!JWT_REGEX.test(jwt)) throw new IdentityError("creds: the user JWT block is not a JWT");
  const seed = extractBlock(text, BEGIN_SEED_REGEX, "USER NKEY SEED");
  return { jwt, seed };
}

function extractBlock(text: string, begin: RegExp, label: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!begin.test(lines[i]!.trim())) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j]!.trim();
      if (candidate.length === 0) continue;
      if (candidate.startsWith("-")) {
        throw new IdentityError(`creds: empty ${label} block at line ${i + 1}`);
      }
      return candidate;
    }
    throw new IdentityError(`creds: ${label} block at line ${i + 1} has no content`);
  }
  throw new IdentityError(`creds: no -----BEGIN ${label}----- block found`);
}

/** Decode the payload (second part) of a JWT without verifying it. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new IdentityError("JWT does not have three parts");
  let payload: unknown;
  try {
    payload = JSON.parse(utf8.decode(base64UrlDecode(parts[1]!.replace(/=+$/, ""))));
  } catch {
    throw new IdentityError("JWT payload is not base64url-encoded JSON");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new IdentityError("JWT payload is not a JSON object");
  }
  return payload as Record<string, unknown>;
}

/**
 * The agent ID a user JWT carries: `sub` is the user NKEY; the account is
 * `nats.issuer_account` when a signing key issued the JWT, else `iss`.
 */
export function identityFromJwt(jwt: string): AgentId {
  const payload = decodeJwtPayload(jwt);
  const sub = payload["sub"];
  const iss = payload["iss"];
  const nats = payload["nats"];
  const issuerAccount =
    typeof nats === "object" && nats !== null && !Array.isArray(nats)
      ? (nats as Record<string, unknown>)["issuer_account"]
      : undefined;
  const account =
    typeof issuerAccount === "string" && issuerAccount.length > 0 ? issuerAccount : iss;
  if (typeof sub !== "string" || typeof account !== "string") {
    throw new IdentityUnavailableError("credentials JWT lacks a string `sub` or `iss`");
  }
  try {
    return newAgentId(account, sub);
  } catch (err) {
    throw new IdentityUnavailableError(
      `credentials JWT does not carry a usable (account, user) pair: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Build a signer from credentials-file text. The signer carries the user
 * JWT so `selfId()` can read the identity without asking the server. A
 * seed that does not belong to the JWT's `sub` is rejected with
 * `IdentityMismatchError` (public keys only in the message).
 */
export function signerFromCreds(credsText: string): SenderSigner {
  const { jwt, seed } = parseCreds(credsText);
  const signer = signerFromSeed(seed, jwt);
  const jwtUser = agentIdUser(identityFromJwt(jwt));
  if (jwtUser !== signer.publicKey) {
    signer.wipe?.();
    throw new IdentityMismatchError(signer.publicKey, jwtUser);
  }
  return signer;
}

/** {@link signerFromCreds} over a file path (`~/` expanded). */
export async function signerFromCredsFile(path: string): Promise<SenderSigner> {
  const resolved = expandHome(path);
  let text: string;
  try {
    text = await readFile(resolved, "utf8");
  } catch (error) {
    throw new IdentityError(`failed to read creds file ${resolved}`, { cause: error });
  }
  return signerFromCreds(text);
}

/**
 * Build a signer from a `nats` CLI context (`"current"` resolves the
 * selected one): `creds` → {@link signerFromCredsFile}; else `nkey` (a seed
 * file) → {@link signerFromSeed}; else inline `user_seed` (+ `user_jwt`).
 * Reuses the context *reader*, not the connection-option builder.
 */
export async function signerFromContext(selector: string): Promise<SenderSigner> {
  const { name, fields } = await readContextFile(selector);
  const creds = optionalString(fields["creds"]);
  const nkey = optionalString(fields["nkey"]);
  const userSeed = optionalString(fields["user_seed"]);
  const userJwt = optionalString(fields["user_jwt"]);
  if (creds !== undefined) return signerFromCredsFile(creds);
  if (nkey !== undefined) {
    const bytes = await readAuthFile("nkey", expandHome(nkey));
    return signerFromSeed(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
  if (userSeed !== undefined) {
    const signer = signerFromSeed(userSeed, userJwt);
    if (userJwt !== undefined) {
      const jwtUser = agentIdUser(identityFromJwt(userJwt));
      if (jwtUser !== signer.publicKey) {
        signer.wipe?.();
        throw new IdentityMismatchError(signer.publicKey, jwtUser);
      }
    }
    return signer;
  }
  throw new IdentityError(
    `NATS context "${name}" has no creds, nkey, or user_seed — nothing to sign Agent-Sender with`,
  );
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// Small crypto helpers for the sender-identity extension: validating
// base64url (no padding), SHA-256 via WebCrypto, and ed25519 verification
// through `@nats-io/nkeys` public keys (decoded once into a small LRU).

import { fromPublic, type KeyPair } from "@nats-io/nkeys";

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_REGEX = /^[A-Za-z0-9_-]*$/;
const B64URL_LOOKUP = ((): Int8Array => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) t[B64URL_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** RFC 4648 §5 base64url, no padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    out += B64URL_ALPHABET[b0 >> 2]!;
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]!;
    out += B64URL_ALPHABET[b2 & 0x3f]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const b0 = bytes[i]!;
    out += B64URL_ALPHABET[b0 >> 2]!;
    out += B64URL_ALPHABET[(b0 & 0x03) << 4]!;
  } else if (rem === 2) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    out += B64URL_ALPHABET[b0 >> 2]!;
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += B64URL_ALPHABET[(b1 & 0x0f) << 2]!;
  }
  return out;
}

/**
 * Validating base64url decode: alphabet `[A-Za-z0-9_-]` only, no padding
 * characters, a length that is not ≡ 1 (mod 4). Throws on anything else.
 */
export function base64UrlDecode(s: string): Uint8Array {
  if (!B64URL_REGEX.test(s)) throw new Error("invalid base64url character");
  if (s.length % 4 === 1) throw new Error("invalid base64url length");
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let buf = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    buf = (buf << 6) | B64URL_LOOKUP[s.charCodeAt(i)]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

/** SHA-256 of `data` (WebCrypto — available on Node ≥ 20 and Bun). */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** Lowercase hex SHA-256 of `data` — the payload line of the signed inputs. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// Decoded public keys, small LRU: verifying a header is one ed25519 check,
// but `fromPublic` re-decodes base32 + CRC each time; a few hundred keys
// cover any realistic set of senders.
const KEY_CACHE_MAX = 256;
const keyCache = new Map<string, KeyPair>();

function publicKeyPair(publicKey: string): KeyPair {
  const cached = keyCache.get(publicKey);
  if (cached) {
    // refresh recency
    keyCache.delete(publicKey);
    keyCache.set(publicKey, cached);
    return cached;
  }
  const kp = fromPublic(publicKey);
  keyCache.set(publicKey, kp);
  if (keyCache.size > KEY_CACHE_MAX) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) keyCache.delete(oldest);
  }
  return kp;
}

/**
 * ed25519 verification against a public NKEY (`U…` / `A…`). Returns
 * `false` for an undecodable key rather than throwing — callers validate
 * the key shape before this point, so a throw here would only ever be a
 * bug surfacing as a 500 instead of a 401.
 */
export function verifyWithPublicKey(
  publicKey: string,
  input: Uint8Array,
  sig: Uint8Array,
): boolean {
  let kp: KeyPair;
  try {
    kp = publicKeyPair(publicKey);
  } catch {
    return false;
  }
  try {
    return kp.verify(input, sig);
  } catch {
    return false;
  }
}

export const utf8 = {
  encode: (s: string): Uint8Array => new TextEncoder().encode(s),
  decode: (b: Uint8Array): string => new TextDecoder().decode(b),
};

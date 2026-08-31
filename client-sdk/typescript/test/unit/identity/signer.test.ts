// Signers: seed / creds / JWT parsing, redaction, wipe, and the context
// reader split (`signerFromContext`).

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { createAccount, createUser } from "@nats-io/nkeys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IdentityError,
  IdentityMismatchError,
  IdentityUnavailableError,
  NatsContextError,
} from "../../../src/errors.js";
import { base64UrlEncode } from "../../../src/identity/crypto.js";
import {
  decodeJwtPayload,
  identityFromJwt,
  normalizeUserSeed,
  parseCreds,
  signerFromCanonicalSeedAndJwt,
  signerFromContext,
  signerFromCreds,
  signerFromCredsFile,
  signerFromSeed,
} from "../../../src/identity/signer.js";
import { agentIdAccount, agentIdUser } from "../../../src/identity/agent-id.js";

const enc = new TextEncoder();
const user = createUser();
const seed = new TextDecoder().decode(user.getSeed());
const account = createAccount();

/** A user JWT with the given claims (unsigned third part — the server verifies JWTs, the SDK only reads them). */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string => base64UrlEncode(enc.encode(JSON.stringify(o)));
  return `${b64({ typ: "JWT", alg: "ed25519-nkey" })}.${b64(payload)}.${base64UrlEncode(new Uint8Array(64))}`;
}

function credsText(jwt: string, seedText: string): string {
  return [
    "-----BEGIN NATS USER JWT-----",
    jwt,
    "------END NATS USER JWT------",
    "",
    "************************* IMPORTANT *************************",
    "NKEY Seed printed below can be used to sign and prove identity.",
    "",
    "-----BEGIN USER NKEY SEED-----",
    seedText,
    "------END USER NKEY SEED------",
    "",
    "*************************************************************",
    "",
  ].join("\n");
}

describe("signerFromSeed", () => {
  it("derives the public key, signs verifiably, tolerates surrounding whitespace and a BEGIN block", () => {
    const s = signerFromSeed(`  ${seed}\n`);
    expect(s.publicKey).toBe(user.getPublicKey());
    const sig = s.sign(enc.encode("hello")) as Uint8Array;
    expect(user.verify(enc.encode("hello"), sig)).toBe(true);
    expect(signerFromSeed(enc.encode(seed)).publicKey).toBe(user.getPublicKey());
    expect(
      signerFromSeed(`-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------\n`)
        .publicKey,
    ).toBe(user.getPublicKey());
  });

  it("rejects a non-user seed, garbage, a public key — without echoing the input", () => {
    const accountSeed = new TextDecoder().decode(account.getSeed());
    // Do not mutate the final base32 character: it contains padding bits, so
    // some textual changes decode to the same bytes on different runtimes.
    const badCrc = `${seed.slice(0, 10)}${seed[10] === "A" ? "B" : "A"}${seed.slice(11)}`;
    for (const bad of [accountSeed, "garbage", user.getPublicKey(), badCrc]) {
      let caught: unknown;
      try {
        signerFromSeed(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught, bad.slice(0, 8)).toBeInstanceOf(IdentityError);
      expect((caught as Error).message).not.toContain(bad);
    }
  });

  it("redacts the key from JSON / inspect / toString and supports wipe()", () => {
    const s = signerFromSeed(seed);
    expect(JSON.stringify(s)).toBe(JSON.stringify({ publicKey: s.publicKey }));
    expect(inspect(s)).toBe(`SenderSigner(${s.publicKey})`);
    s.wipe?.();
    expect(() => s.sign(enc.encode("x"))).toThrow(/wiped/);
  });

  it("wipes an owned canonical seed when JWT validation fails", () => {
    const canonicalSeed = normalizeUserSeed(seed);
    expect(() => signerFromCanonicalSeedAndJwt(canonicalSeed, "malformed-jwt")).toThrow(
      IdentityError,
    );
    expect(canonicalSeed.every((byte) => byte === 0)).toBe(true);
  });
});

describe("creds + JWT parsing", () => {
  const jwt = fakeJwt({
    sub: user.getPublicKey(),
    iss: account.getPublicKey(),
    nats: { type: "user" },
  });

  it("parseCreds extracts the two blocks", () => {
    expect(parseCreds(credsText(jwt, seed))).toEqual({ jwt, seed });
  });

  it("parseCreds errors name the block, not the content", () => {
    expect(() => parseCreds("nothing here")).toThrow(/no -----BEGIN NATS USER JWT----- block/);
    expect(() =>
      parseCreds("-----BEGIN NATS USER JWT-----\n------END NATS USER JWT------\n"),
    ).toThrow(/empty NATS USER JWT block at line 1/);
    expect(() =>
      parseCreds(`-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n`),
    ).toThrow(/USER NKEY SEED/);
  });

  it("decodeJwtPayload / identityFromJwt: sub → user, nats.issuer_account wins over iss", () => {
    expect(decodeJwtPayload(jwt)["sub"]).toBe(user.getPublicKey());
    const id = identityFromJwt(jwt);
    expect(agentIdUser(id)).toBe(user.getPublicKey());
    expect(agentIdAccount(id)).toBe(account.getPublicKey());
    const signing = createAccount();
    const viaSigningKey = fakeJwt({
      sub: user.getPublicKey(),
      iss: signing.getPublicKey(),
      nats: { issuer_account: account.getPublicKey() },
    });
    expect(agentIdAccount(identityFromJwt(viaSigningKey))).toBe(account.getPublicKey());
    expect(() => identityFromJwt("a.b")).toThrow(IdentityError);
    expect(() => identityFromJwt("a.!!!.c")).toThrow(IdentityError);
    expect(() => identityFromJwt(fakeJwt({ iss: "x" }))).toThrow(IdentityUnavailableError);
    expect(() => identityFromJwt(fakeJwt({ sub: "notakey", iss: account.getPublicKey() }))).toThrow(
      IdentityUnavailableError,
    );
  });

  it("signerFromCreds carries the JWT and rejects a seed that is not the JWT's sub", () => {
    const s = signerFromCreds(credsText(jwt, seed));
    expect(s.jwt).toBe(jwt);
    expect(s.publicKey).toBe(user.getPublicKey());
    const otherSeed = new TextDecoder().decode(createUser().getSeed());
    let caught: unknown;
    try {
      signerFromCreds(credsText(jwt, otherSeed));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IdentityMismatchError);
    expect((caught as Error).message).not.toContain(otherSeed);
  });
});

describe("signerFromCredsFile / signerFromContext", () => {
  let dir = "";
  let originalConfigHome: string | undefined;
  const jwt = fakeJwt({ sub: user.getPublicKey(), iss: account.getPublicKey() });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "synadia-signer-"));
    await mkdir(join(dir, "context"), { recursive: true });
    await writeFile(join(dir, "user.creds"), credsText(jwt, seed));
    await writeFile(join(dir, "user.nk"), `${seed}\n`);
    const ctx = (name: string, fields: Record<string, unknown>): Promise<void> =>
      writeFile(
        join(dir, "context", `${name}.json`),
        JSON.stringify({ url: "nats://127.0.0.1:4222", ...fields }),
      );
    await ctx("creds", { creds: join(dir, "user.creds") });
    await ctx("nkey", { nkey: join(dir, "user.nk") });
    await ctx("inline", { user_jwt: jwt, user_seed: seed });
    await ctx("password", { user: "u", password: "p" });
    await ctx("missing", { nkey: join(dir, "nope.nk") });
    originalConfigHome = process.env["NATS_CONFIG_HOME"];
    process.env["NATS_CONFIG_HOME"] = dir;
  });

  afterAll(async () => {
    if (originalConfigHome === undefined) delete process.env["NATS_CONFIG_HOME"];
    else process.env["NATS_CONFIG_HOME"] = originalConfigHome;
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a creds file", async () => {
    const s = await signerFromCredsFile(join(dir, "user.creds"));
    expect(s.publicKey).toBe(user.getPublicKey());
    expect(s.jwt).toBe(jwt);
    await expect(signerFromCredsFile(join(dir, "nope.creds"))).rejects.toBeInstanceOf(
      IdentityError,
    );
  });

  it("resolves creds > nkey > user_seed from a context; a password context has nothing to sign with", async () => {
    expect((await signerFromContext("creds")).jwt).toBe(jwt);
    expect((await signerFromContext("nkey")).publicKey).toBe(user.getPublicKey());
    expect((await signerFromContext("nkey")).jwt).toBeUndefined();
    expect((await signerFromContext("inline")).jwt).toBe(jwt);
    await expect(signerFromContext("password")).rejects.toThrow(/nothing to sign/);
    await expect(signerFromContext("missing")).rejects.toBeInstanceOf(NatsContextError);
    await expect(signerFromContext("does-not-exist")).rejects.toBeInstanceOf(NatsContextError);
  });
});

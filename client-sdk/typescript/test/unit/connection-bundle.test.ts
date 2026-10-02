import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { createAccount, createUser } from "@nats-io/nkeys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveNatsConnectionBundle,
  type NatsConnectionSource,
} from "../../src/connection-bundle.js";
import { IdentityError, NatsContextError } from "../../src/errors.js";
import { base64UrlEncode } from "../../src/identity/crypto.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fakeJwt(user: string, account: string): string {
  const part = (value: unknown): string => base64UrlEncode(encoder.encode(JSON.stringify(value)));
  return `${part({ typ: "JWT", alg: "ed25519-nkey" })}.${part({ sub: user, iss: account })}.${base64UrlEncode(new Uint8Array(64))}`;
}

function credsText(jwt: string, seed: string): string {
  return [
    "-----BEGIN NATS USER JWT-----",
    jwt,
    "------END NATS USER JWT------",
    "",
    "-----BEGIN USER NKEY SEED-----",
    seed,
    "------END USER NKEY SEED------",
    "",
  ].join("\n");
}

describe("resolveNatsConnectionBundle", () => {
  let root = "";
  let originalConfigHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "connection-bundle-"));
    await mkdir(join(root, "context"), { recursive: true });
    originalConfigHome = process.env["NATS_CONFIG_HOME"];
    process.env["NATS_CONFIG_HOME"] = root;
  });

  afterEach(async () => {
    if (originalConfigHome === undefined) delete process.env["NATS_CONFIG_HOME"];
    else process.env["NATS_CONFIG_HOME"] = originalConfigHome;
    await rm(root, { recursive: true, force: true });
  });

  it("keeps identity off by default or explicitly and does not parse a signer", async () => {
    const path = join(root, "opaque.creds");
    await writeFile(path, "connection-auth-bytes-that-are-not-a-signer");

    const dynamicMode = (enabled: boolean): "off" | "signed" => (enabled ? "signed" : "off");
    const identity = dynamicMode(false);
    const bundle = await resolveNatsConnectionBundle(
      {
        url: "nats://token-value@demo.example:4222",
        creds: path,
      },
      { identity },
    );

    expect(bundle.connectionOptions.servers).toEqual(["nats://demo.example:4222"]);
    expect(bundle.connectionOptions.authenticator).toBeDefined();
    expect(bundle.connectionOptions.token).toBeUndefined();
    expect("signer" in bundle).toBe(false);
    expect(JSON.stringify(bundle)).toBe('{"identity":"off"}');
    expect(inspect(bundle)).toBe("NatsConnectionBundle(off)");
    expect(Object.keys(bundle)).toEqual([]);
    bundle.wipe();
    bundle.wipe();
  });

  it("derives direct creds connection auth and signer from one resolved snapshot", async () => {
    const alice = createUser();
    const bob = createUser();
    const account = createAccount();
    const aliceSeed = decoder.decode(alice.getSeed());
    const bobSeed = decoder.decode(bob.getSeed());
    const path = join(root, "rotating.creds");
    const aliceJwt = fakeJwt(alice.getPublicKey(), account.getPublicKey());
    await writeFile(path, credsText(aliceJwt, aliceSeed));

    const bundle = await resolveNatsConnectionBundle(
      { url: "nats://demo.example:4222", creds: path },
      { identity: "signed" },
    );
    await writeFile(path, credsText(fakeJwt(bob.getPublicKey(), account.getPublicKey()), bobSeed));

    expect(bundle.signer.publicKey).toBe(alice.getPublicKey());
    expect(bundle.connectionOptions.authenticator).toBeDefined();
    const configured = Array.isArray(bundle.connectionOptions.authenticator)
      ? bundle.connectionOptions.authenticator[0]
      : bundle.connectionOptions.authenticator;
    const auth = configured?.("rotation-nonce");
    expect(auth && "jwt" in auth ? auth.jwt : undefined).toBe(aliceJwt);
    expect(auth && "nkey" in auth ? auth.nkey : undefined).toBe(alice.getPublicKey());
    expect(await readFile(path, "utf8")).toContain(bobSeed);
    bundle.wipe();
    bundle.wipe();
    expect(bundle.connectionOptions.authenticator).toBeUndefined();
    expect(() => bundle.signer.sign(encoder.encode("after wipe"))).toThrow(/wiped/);
  });

  it.each([
    ["trailing newline", (value: string): string => `${value}\n`],
    [
      "BEGIN block",
      (value: string): string =>
        `-----BEGIN USER NKEY SEED-----\n${value}\n------END USER NKEY SEED------\n`,
    ],
  ])("supports direct nkey with a %s", async (_label, format) => {
    const user = createUser();
    const path = join(root, "user.nk");
    await writeFile(path, format(decoder.decode(user.getSeed())));

    const bundle = await resolveNatsConnectionBundle(
      { url: "nats://demo.example:4222", nkey: path },
      { identity: "signed" },
    );

    expect(bundle.signer.publicKey).toBe(user.getPublicKey());
    expect(bundle.connectionOptions.authenticator).toBeDefined();
    bundle.wipe();
  });

  it("uses one context snapshot for creds, nkey, inline JWT+seed, and TLS options", async () => {
    const user = createUser();
    const account = createAccount();
    const seed = decoder.decode(user.getSeed());
    const jwt = fakeJwt(user.getPublicKey(), account.getPublicKey());
    const creds = join(root, "user.creds");
    const nkey = join(root, "user.nk");
    const ca = join(root, "ca.pem");
    await writeFile(creds, credsText(jwt, seed));
    await writeFile(
      nkey,
      `-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------\n`,
    );
    await writeFile(ca, "test-ca");
    await writeContext("creds", { url: "tls://demo.example:4222", creds, ca });
    await writeContext("nkey", { url: "nats://demo.example:4222", nkey });
    await writeContext("inline", {
      url: "nats://demo.example:4222",
      user_jwt: jwt,
      user_seed: seed,
    });

    for (const name of ["creds", "nkey", "inline"]) {
      const bundle = await resolveNatsConnectionBundle({ context: name }, { identity: "signed" });
      expect(bundle.signer.publicKey).toBe(user.getPublicKey());
      expect(bundle.connectionOptions.authenticator).toBeDefined();
      if (name === "creds") expect(bundle.connectionOptions.tls?.ca).toBe("test-ca");
      bundle.wipe();
      if (name === "creds") expect(bundle.connectionOptions.tls).toBeUndefined();
    }
  });

  it("allows non-seed auth when identity is off and fails clearly when signed", async () => {
    await writeContext("password", {
      url: "nats://demo.example:4222",
      user: "alice",
      password: "not-logged",
    });
    const off = await resolveNatsConnectionBundle({ context: "password" });
    expect(off.connectionOptions.user).toBe("alice");
    expect("signer" in off).toBe(false);
    off.wipe();
    expect(off.connectionOptions.user).toBeUndefined();
    expect(off.connectionOptions.pass).toBeUndefined();

    await expect(
      resolveNatsConnectionBundle({ context: "password" }, { identity: "signed" }),
    ).rejects.toThrow(/has no user seed/);

    await writeContext("url-token", {
      url: "nats://context-url-token@demo.example:4222",
    });
    const urlTokenOff = await resolveNatsConnectionBundle({ context: "url-token" });
    expect(urlTokenOff.connectionOptions.servers).toEqual(["nats://demo.example:4222"]);
    expect(urlTokenOff.connectionOptions.token).toBe("context-url-token");
    urlTokenOff.wipe();
    await expect(
      resolveNatsConnectionBundle({ context: "url-token" }, { identity: "signed" }),
    ).rejects.toThrow(/has no user seed/);

    await expect(
      resolveNatsConnectionBundle(
        { url: "nats://token@demo.example:4222" },
        {
          identity: "signed",
        },
      ),
    ).rejects.toThrow(/requires URL connection credentials/);
  });

  it("redacts URL token/password and option internals from JSON and inspection", async () => {
    const password = "password-sentinel-7f486";
    const token = "token-sentinel-82a04";
    const passwordBundle = await resolveNatsConnectionBundle({
      url: `nats://alice:${password}@demo.example:4222`,
    });
    const tokenBundle = await resolveNatsConnectionBundle({
      url: `nats://${token}@demo.example:4222`,
    });

    expect(passwordBundle.connectionOptions.pass).toBe(password);
    expect(tokenBundle.connectionOptions.token).toBe(token);
    for (const bundle of [passwordBundle, tokenBundle]) {
      expect(JSON.stringify(bundle)).not.toContain(password);
      expect(JSON.stringify(bundle)).not.toContain(token);
      expect(inspect(bundle)).not.toContain(password);
      expect(inspect(bundle)).not.toContain(token);
    }
    passwordBundle.wipe();
    tokenBundle.wipe();
    expect(passwordBundle.connectionOptions.user).toBeUndefined();
    expect(passwordBundle.connectionOptions.pass).toBeUndefined();
    expect(tokenBundle.connectionOptions.token).toBeUndefined();
  });

  it("preserves WebSocket paths and queries in direct and context sources", async () => {
    const direct = await resolveNatsConnectionBundle({
      url: "wss://direct-token@ws.example.test/nats?tenant=direct",
    });
    expect(direct.connectionOptions.servers).toEqual(["wss://ws.example.test/nats?tenant=direct"]);
    expect(direct.connectionOptions.token).toBe("direct-token");

    await writeContext("websocket", {
      url: "ws://context-token@ws.example.test:9222/nats?tenant=context",
    });
    const context = await resolveNatsConnectionBundle({ context: "websocket" });
    expect(context.connectionOptions.servers).toEqual([
      "ws://ws.example.test:9222/nats?tenant=context",
    ]);
    expect(context.connectionOptions.token).toBe("context-token");
    direct.wipe();
    context.wipe();
  });

  it("redacts URL userinfo from resolver errors while retaining the host", async () => {
    const token = "resolver-error-token-sentinel";
    let caught: unknown;
    try {
      await resolveNatsConnectionBundle({
        url: `nats://${token}@one.example:4222,nats://different@two.example:4222`,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NatsContextError);
    expect((caught as Error).message).toContain("one.example:4222");
    expect((caught as Error).message).not.toContain(token);
    expect((caught as Error).message).not.toContain("different");
  });

  it("rejects ambiguous sources without exposing their values", async () => {
    const ambiguous = {
      url: "nats://secret-token@demo.example:4222",
      creds: "/secret/alice.creds",
      nkey: "/secret/bob.nk",
    } as unknown as NatsConnectionSource;
    let caught: unknown;
    try {
      await resolveNatsConnectionBundle(ambiguous);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NatsContextError);
    expect((caught as Error).message).not.toContain("secret-token");
    expect((caught as Error).message).not.toContain("alice.creds");
    expect((caught as Error).message).not.toContain("bob.nk");

    await expect(
      resolveNatsConnectionBundle({ url: "nats://demo.example:4222" }, {
        identity: "invalid",
      } as never),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it("validates runtime source shapes without misrouting undefined fields", async () => {
    const withUndefinedContext = {
      context: undefined,
      url: "nats://demo.example:4222",
    } as unknown as NatsConnectionSource;
    const bundle = await resolveNatsConnectionBundle(withUndefinedContext);
    expect(bundle.connectionOptions.servers).toEqual(["nats://demo.example:4222"]);
    bundle.wipe();

    await expect(
      resolveNatsConnectionBundle({
        url: "nats://demo.example:4222",
        creds: 42,
      } as unknown as NatsConnectionSource),
    ).rejects.toThrow(/`creds` must be a non-empty string/);
    await expect(resolveNatsConnectionBundle(null as never)).rejects.toThrow(
      /source must be an object/,
    );
  });

  async function writeContext(name: string, fields: Record<string, unknown>): Promise<void> {
    await writeFile(join(root, "context", `${name}.json`), JSON.stringify(fields));
  }
});

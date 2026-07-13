import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadContextOptions, parseNatsUrl } from "../../src/context.js";
import { NatsContextError } from "../../src/errors.js";

describe("loadContextOptions", () => {
  let baseDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "nats-ctx-"));
    await mkdir(join(baseDir, "context"), { recursive: true });
    savedEnv["NATS_CONFIG_HOME"] = process.env["NATS_CONFIG_HOME"];
    savedEnv["NATS_CONTEXT"] = process.env["NATS_CONTEXT"];
    savedEnv["XDG_CONFIG_HOME"] = process.env["XDG_CONFIG_HOME"];
    process.env["NATS_CONFIG_HOME"] = baseDir;
    delete process.env["NATS_CONTEXT"];
    delete process.env["XDG_CONFIG_HOME"];
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(baseDir, { recursive: true, force: true });
  });

  async function writeContext(name: string, body: Record<string, unknown>): Promise<void> {
    await writeFile(join(baseDir, "context", `${name}.json`), JSON.stringify(body));
  }

  it("returns servers split from a comma-separated url", async () => {
    await writeContext("multi", { url: "nats://a:4222, nats://b:4222 ,nats://c:4222" });
    const opts = await loadContextOptions("multi");
    expect(opts.servers).toEqual(["nats://a:4222", "nats://b:4222", "nats://c:4222"]);
  });

  it("maps user/password/token/inbox_prefix", async () => {
    await writeContext("creds-basic", {
      url: "nats://localhost:4222",
      user: "alice",
      password: "s3cret",
      token: "tok",
      inbox_prefix: "_INBOX.alice",
    });
    const opts = await loadContextOptions("creds-basic");
    expect(opts.user).toBe("alice");
    expect(opts.pass).toBe("s3cret");
    expect(opts.token).toBe("tok");
    expect(opts.inboxPrefix).toBe("_INBOX.alice");
  });

  it("prefers user_jwt over user/password/token", async () => {
    await writeContext("jwt", {
      url: "nats://localhost:4222",
      user_jwt: "eyJ0eXAiOiJKV1QifQ.payload.sig",
      user: "ignored",
      password: "ignored",
      token: "ignored",
    });
    const opts = await loadContextOptions("jwt");
    expect(opts.authenticator).toBeDefined();
    expect(opts.user).toBeUndefined();
    expect(opts.pass).toBeUndefined();
    expect(opts.token).toBeUndefined();
  });

  it("resolves selector 'current' from $NATS_CONTEXT", async () => {
    await writeContext("prod", { url: "nats://prod:4222" });
    process.env["NATS_CONTEXT"] = "prod";
    const opts = await loadContextOptions("current");
    expect(opts.servers).toEqual(["nats://prod:4222"]);
  });

  it("resolves selector 'current' from context.txt when env unset", async () => {
    await writeContext("staging", { url: "nats://staging:4222" });
    await writeFile(join(baseDir, "context.txt"), "staging\n");
    const opts = await loadContextOptions("current");
    expect(opts.servers).toEqual(["nats://staging:4222"]);
  });

  it("throws NatsContextError when context file is missing", async () => {
    await expect(loadContextOptions("nope")).rejects.toBeInstanceOf(NatsContextError);
  });

  it("throws NatsContextError when JSON is malformed", async () => {
    await writeFile(join(baseDir, "context", "bad.json"), "{not json");
    await expect(loadContextOptions("bad")).rejects.toBeInstanceOf(NatsContextError);
  });

  it("throws NatsContextError when url is missing", async () => {
    await writeContext("no-url", { user: "alice" });
    await expect(loadContextOptions("no-url")).rejects.toBeInstanceOf(NatsContextError);
  });

  it("throws NatsContextError when 'current' has no selection", async () => {
    await expect(loadContextOptions("current")).rejects.toBeInstanceOf(NatsContextError);
  });

  it("loads creds file and sets authenticator", async () => {
    const credsPath = join(baseDir, "user.creds");
    await writeFile(
      credsPath,
      "-----BEGIN NATS USER JWT-----\nstub\n------END NATS USER JWT------\n" +
        "-----BEGIN USER NKEY SEED-----\nSUASTUB\n------END USER NKEY SEED------\n",
    );
    await writeContext("with-creds", {
      url: "nats://localhost:4222",
      creds: credsPath,
      user: "ignored",
      token: "ignored",
    });
    const opts = await loadContextOptions("with-creds");
    expect(opts.authenticator).toBeDefined();
    expect(opts.user).toBeUndefined();
    expect(opts.token).toBeUndefined();
  });

  it("rejects context names that contain path separators", async () => {
    await expect(loadContextOptions("../escape")).rejects.toBeInstanceOf(NatsContextError);
    await expect(loadContextOptions("foo/../etc/passwd")).rejects.toBeInstanceOf(NatsContextError);
    await expect(loadContextOptions("foo\\bar")).rejects.toBeInstanceOf(NatsContextError);
    await expect(loadContextOptions("..")).rejects.toBeInstanceOf(NatsContextError);
    await expect(loadContextOptions("foo\0bar")).rejects.toBeInstanceOf(NatsContextError);
  });

  it("rejects traversal names resolved via $NATS_CONTEXT", async () => {
    process.env["NATS_CONTEXT"] = "../escape";
    await expect(loadContextOptions("current")).rejects.toBeInstanceOf(NatsContextError);
  });

  it("loads nkey file and sets authenticator", async () => {
    const nkeyPath = join(baseDir, "user.nk");
    // 32-byte stub seed bytes (real nkeys are base32 of an Ed25519 seed; the
    // authenticator only needs the bytes here, the wire signing is exercised
    // in integration tests).
    await writeFile(nkeyPath, new Uint8Array(32));
    await writeContext("with-nkey", {
      url: "nats://localhost:4222",
      nkey: nkeyPath,
      token: "ignored",
    });
    const opts = await loadContextOptions("with-nkey");
    expect(opts.authenticator).toBeDefined();
    expect(opts.token).toBeUndefined();
  });

  it("wraps creds file read failures", async () => {
    const credsPath = join(baseDir, "missing.creds");
    await writeContext("missing-creds", {
      url: "nats://localhost:4222",
      creds: credsPath,
    });
    await expect(loadContextOptions("missing-creds")).rejects.toThrow(NatsContextError);
    await expect(loadContextOptions("missing-creds")).rejects.toThrow(
      `failed to read creds file ${credsPath}`,
    );
  });

  it("wraps nkey file read failures", async () => {
    const nkeyPath = join(baseDir, "missing.nk");
    await writeContext("missing-nkey", {
      url: "nats://localhost:4222",
      nkey: nkeyPath,
    });
    await expect(loadContextOptions("missing-nkey")).rejects.toThrow(NatsContextError);
    await expect(loadContextOptions("missing-nkey")).rejects.toThrow(
      `failed to read nkey file ${nkeyPath}`,
    );
  });

  it("uses inline user_jwt + user_seed when both are present", async () => {
    await writeContext("with-jwt-seed", {
      url: "nats://localhost:4222",
      user_jwt: "eyJ0eXAiOiJKV1QifQ.payload.sig",
      user_seed: "SUASTUBSEED",
    });
    const opts = await loadContextOptions("with-jwt-seed");
    expect(opts.authenticator).toBeDefined();
  });

  it("falls back to jwt-only when no user_seed is provided", async () => {
    await writeContext("with-jwt-only", {
      url: "nats://localhost:4222",
      user_jwt: "eyJ0eXAiOiJKV1QifQ.payload.sig",
    });
    const opts = await loadContextOptions("with-jwt-only");
    expect(opts.authenticator).toBeDefined();
  });

  it("creds wins over nkey wins over user_jwt wins over user/pass/token", async () => {
    const credsPath = join(baseDir, "user.creds");
    await writeFile(credsPath, "stub-creds");
    const nkeyPath = join(baseDir, "user.nk");
    await writeFile(nkeyPath, new Uint8Array(32));
    await writeContext("precedence", {
      url: "nats://localhost:4222",
      creds: credsPath,
      nkey: nkeyPath,
      user_jwt: "eyJ.x.y",
      user: "alice",
      password: "secret",
      token: "tok",
    });
    const opts = await loadContextOptions("precedence");
    // creds takes the authenticator slot; the other auth fields are dropped.
    expect(opts.authenticator).toBeDefined();
    expect(opts.user).toBeUndefined();
    expect(opts.pass).toBeUndefined();
    expect(opts.token).toBeUndefined();
  });

  it("loads the TLS triple when cert/key/ca/tls_first are present", async () => {
    const certPath = join(baseDir, "client.pem");
    const keyPath = join(baseDir, "client.key");
    const caPath = join(baseDir, "ca.pem");
    await writeFile(certPath, "client-cert");
    await writeFile(keyPath, "client-key");
    await writeFile(caPath, "ca-cert");
    await writeContext("with-tls", {
      url: "tls://nats.example.com:4222",
      cert: certPath,
      key: keyPath,
      ca: caPath,
      tls_first: true,
    });
    const opts = await loadContextOptions("with-tls");
    expect(opts.tls).toEqual({
      cert: "client-cert",
      key: "client-key",
      ca: "ca-cert",
      handshakeFirst: true,
    });
  });

  it("wraps TLS file read failures", async () => {
    const certPath = join(baseDir, "missing-client.pem");
    await writeContext("missing-tls", {
      url: "tls://nats.example.com:4222",
      cert: certPath,
    });
    await expect(loadContextOptions("missing-tls")).rejects.toThrow(NatsContextError);
    await expect(loadContextOptions("missing-tls")).rejects.toThrow(
      `failed to read TLS cert file ${certPath}`,
    );
  });

  it("sets handshakeFirst alone when only tls_first is set", async () => {
    await writeContext("tls-first-only", {
      url: "tls://nats.example.com:4222",
      tls_first: true,
    });
    const opts = await loadContextOptions("tls-first-only");
    expect(opts.tls).toEqual({ handshakeFirst: true });
  });

  it("loads a partial TLS triple (ca only)", async () => {
    const caPath = join(baseDir, "ca-only.pem");
    await writeFile(caPath, "ca-only-cert");
    await writeContext("ca-only", {
      url: "tls://nats.example.com:4222",
      ca: caPath,
    });
    const opts = await loadContextOptions("ca-only");
    expect(opts.tls).toEqual({ ca: "ca-only-cert" });
  });

  it("leaves TLS undefined when none of cert/key/ca/tls_first are set", async () => {
    await writeContext("no-tls", { url: "nats://localhost:4222" });
    const opts = await loadContextOptions("no-tls");
    expect(opts.tls).toBeUndefined();
  });
});

describe("parseNatsUrl", () => {
  it("returns bare servers with no auth for a plain URL", () => {
    const opts = parseNatsUrl("nats://nats.example.com:4222");
    expect(opts).toEqual({ servers: ["nats://nats.example.com:4222"] });
    expect(opts.token).toBeUndefined();
    expect(opts.user).toBeUndefined();
    expect(opts.pass).toBeUndefined();
  });

  it("treats single userinfo component as a token (mirrors `nats` CLI)", () => {
    const opts = parseNatsUrl("nats://abc123def@nats.example.com:4222");
    expect(opts).toEqual({
      servers: ["nats://nats.example.com:4222"],
      token: "abc123def",
    });
  });

  it("splits user:password userinfo into user + pass", () => {
    const opts = parseNatsUrl("nats://alice:s3cret@nats.example.com:4222");
    expect(opts).toEqual({
      servers: ["nats://nats.example.com:4222"],
      user: "alice",
      pass: "s3cret",
    });
  });

  it("URL-decodes userinfo so tokens with reserved characters round-trip", () => {
    // "%2B" → "+", "%40" → "@"
    const opts = parseNatsUrl("nats://to%2Bken%40v1@nats.example.com:4222");
    expect(opts.token).toBe("to+ken@v1");
  });

  it("preserves the scheme for tls:// (and similar)", () => {
    const opts = parseNatsUrl("tls://abc@nats.example.com:4443");
    expect(opts).toEqual({
      servers: ["tls://nats.example.com:4443"],
      token: "abc",
    });
  });

  it("accepts scheme-less host:port (treats as nats://)", () => {
    const opts = parseNatsUrl("nats.example.com:4222");
    expect(opts.servers).toEqual(["nats://nats.example.com:4222"]);
  });

  it("splits comma-separated multi-server URLs", () => {
    const opts = parseNatsUrl("nats://a:4222,nats://b:4222,nats://c:4222");
    expect(opts.servers).toEqual(["nats://a:4222", "nats://b:4222", "nats://c:4222"]);
    expect(opts.token).toBeUndefined();
  });

  it("accepts multi-server URLs when userinfo is identical on every entry", () => {
    const opts = parseNatsUrl("nats://tok@a.example.com:4222,nats://tok@b.example.com:4222");
    expect(opts.servers).toEqual(["nats://a.example.com:4222", "nats://b.example.com:4222"]);
    expect(opts.token).toBe("tok");
  });

  it("throws when multi-server URLs have mixed credentials", () => {
    expect(() => parseNatsUrl("nats://tok1@a:4222,nats://tok2@b:4222")).toThrow(NatsContextError);
  });

  it("throws on empty / blank input", () => {
    expect(() => parseNatsUrl("")).toThrow(NatsContextError);
    expect(() => parseNatsUrl("   ,  ")).toThrow(NatsContextError);
  });

  it("throws on unsupported scheme", () => {
    expect(() => parseNatsUrl("http://nats.example.com:4222")).toThrow(NatsContextError);
  });

  it("throws on hostless URL", () => {
    expect(() => parseNatsUrl("nats://")).toThrow(NatsContextError);
  });

  it("treats `user:` (explicit colon, empty password) as user:password, not token", () => {
    // WHATWG URL squashes both `nats://user@host` and `nats://user:@host`
    // into `password === ""`, so the implementation re-sniffs the raw
    // input to recover the colon's intent. An empty password is
    // semantically meaningless to the NATS server, but we preserve the
    // structural distinction so this URL form maps where the user expected.
    const opts = parseNatsUrl("nats://alice:@nats.example.com:4222");
    expect(opts).toEqual({
      servers: ["nats://nats.example.com:4222"],
      user: "alice",
      pass: "",
    });
    expect(opts.token).toBeUndefined();
  });

  it("accepts ws:// and wss:// schemes (with userinfo)", () => {
    const ws = parseNatsUrl("ws://tok@host:9222");
    expect(ws).toEqual({ servers: ["ws://host:9222"], token: "tok" });
    const wss = parseNatsUrl("wss://tok@host:9222");
    expect(wss).toEqual({ servers: ["wss://host:9222"], token: "tok" });
    // bare ws/wss without userinfo
    const wsBare = parseNatsUrl("ws://host:9222");
    expect(wsBare).toEqual({ servers: ["ws://host:9222"] });
  });
});

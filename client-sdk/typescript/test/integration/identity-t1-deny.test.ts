// Identity T1′ — an nkey user whose publish permission denies `$SYS.>`:
// `$SYS.REQ.USER.INFO` is a permissions violation. The SDK fails fast
// (`IdentityUnavailableError` at once, no 2 s timeout), memoises the
// failure for 30 s so later requests fail without silently downgrading,
// retries on `refreshSelfId()` or after the TTL, and never blocks identity-
// free `discover()`. Credentials JWTs do not bypass the live binding.

import { readFile } from "node:fs/promises";
import { nkeyAuthenticator, type NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ReferenceAgent } from "@synadia-ai/agent-service/testing";
import {
  AGENT_SENDER_HEADER,
  Agents,
  base64UrlEncode,
  IdentityUnavailableError,
  peekSelfId,
  SELF_ID_NEGATIVE_TTL_MS,
  signerFromSeed,
  type Logger,
  type SenderInfo,
} from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}

const bin = await findNatsServerBinary();
const keys = JSON.parse(await readFile(identityFixture("keys.json"), "utf8")) as KeysFile;
const enc = new TextEncoder();
const ALICE = keys.users["alice"]!;

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string => base64UrlEncode(enc.encode(JSON.stringify(o)));
  return `${b64({ typ: "JWT", alg: "ed25519-nkey" })}.${b64(payload)}.${base64UrlEncode(new Uint8Array(64))}`;
}

describe.skipIf(!bin)("identity T1′ — nkey user, deny $SYS.>", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  let hostNc: NatsConnection;
  let ref: ReferenceAgent;
  const seen: Array<{ sender: SenderInfo | undefined; header: string | undefined }> = [];
  const perTest: Array<() => Promise<void>> = [];
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (m) => {
      warnings.push(m);
    },
    error: () => undefined,
  };

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-deny-sys.conf") });
    const opts = {
      servers: server.url,
      authenticator: nkeyAuthenticator(enc.encode(ALICE.seed)),
      reconnect: false,
    };
    nc = await connect(opts);
    hostNc = await connect(opts);
    ref = new ReferenceAgent({
      nc: hostNc,
      agent: "deny-ref",
      owner: "testers",
      name: "only",
      logger,
      promptHandler: (msg, sender) => {
        seen.push({ sender, header: msg.headers?.get(AGENT_SENDER_HEADER) });
        msg.respond(enc.encode(JSON.stringify({ type: "response", data: "ok" })));
        msg.respond(new Uint8Array(0));
      },
    });
    await ref.start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const c of perTest.splice(0).reverse()) await c();
  });

  afterAll(async () => {
    await ref.stop();
    await nc.close();
    await hostNc.close();
    await server.stop();
  });

  it("an identity-free host starts without lookup metadata or a warning", () => {
    expect(ref.identity).toBeUndefined();
    expect(warnings.some((w) => /without identity metadata/.test(w))).toBe(false);
  });

  it("a signed host fails startup when live binding is unavailable", async () => {
    const signed = new ReferenceAgent({
      nc: hostNc,
      agent: "deny-signed",
      owner: "testers",
      name: "only",
      identity: { signer: signerFromSeed(ALICE.seed) },
    });
    await expect(signed.start()).rejects.toBeInstanceOf(IdentityUnavailableError);
  });

  it("selfId() fails at once with IdentityUnavailableError (permission violation), not after the timeout", async () => {
    const agents = new Agents({ nc, identity: { signer: signerFromSeed(ALICE.seed) } });
    perTest.push(() => agents.close());
    const started = Date.now();
    const err: unknown = await agents.selfId().then(
      () => null,
      (e: unknown) => e,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(IdentityUnavailableError);
    expect((err as Error).message).toMatch(/permissions violation/);
    expect(nc.isClosed()).toBe(false);
  });

  it("a signer failure never downgrades a prompt; refresh and an expired retry still fail fast", async () => {
    const signer = signerFromSeed(ALICE.seed);
    const agents = new Agents({ nc, identity: { signer } });
    perTest.push(() => agents.close());
    await agents.selfId().catch(() => {});
    const failure = peekSelfId(nc, { signer });
    expect(failure && "error" in failure).toBe(true);

    const [agent] = await agents.discover({ timeoutMs: 500, filter: { agent: "deny-ref" } });
    const t0 = Date.now();
    await expect(agent!.prompt("hi")).rejects.toBeInstanceOf(IdentityUnavailableError);
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(seen).toHaveLength(0);

    const t1 = Date.now();
    await expect(agents.refreshSelfId()).rejects.toBeInstanceOf(IdentityUnavailableError);
    expect(Date.now() - t1).toBeLessThan(1_000);

    // Past the negative-cache TTL, a signed operation awaits the retry and
    // still fails rather than proceeding without a header.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + SELF_ID_NEGATIVE_TTL_MS + 1_000);
    expect(peekSelfId(nc, { signer })).toBeUndefined();
    await expect(agent!.prompt("hi again")).rejects.toBeInstanceOf(IdentityUnavailableError);
    expect(seen).toHaveLength(0);
    const after = peekSelfId(nc, { signer });
    expect(after && "error" in after).toBe(true); // the awaited retry failed again, freshly memoised
  });

  it("discover() does not block on the lookup", async () => {
    const fresh = await connect({
      servers: server.url,
      authenticator: nkeyAuthenticator(enc.encode(ALICE.seed)),
      reconnect: false,
    });
    perTest.push(() => fresh.close());
    const agents = new Agents({ nc: fresh });
    perTest.push(() => agents.close());
    const t0 = Date.now();
    const found = await agents.discover({ timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(found.length).toBeGreaterThan(0);
  });

  it("a credentials signer also requires the live lookup", async () => {
    const jwt = fakeJwt({ sub: ALICE.public, iss: "$G", nats: { type: "user" } });
    const fresh = await connect({
      servers: server.url,
      authenticator: nkeyAuthenticator(enc.encode(ALICE.seed)),
      reconnect: false,
    });
    perTest.push(() => fresh.close());
    const agents = new Agents({ nc: fresh, identity: { signer: signerFromSeed(ALICE.seed, jwt) } });
    perTest.push(() => agents.close());
    await expect(agents.selfId()).rejects.toBeInstanceOf(IdentityUnavailableError);
  });
});

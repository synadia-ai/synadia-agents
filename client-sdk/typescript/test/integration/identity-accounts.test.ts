// Identity T2 / T3 / T4 on `accounts.conf` (config-file accounts ACME,
// APP, APP2, APP3) plus the `account_token_position` variant on
// `account-token-position.conf` — cross-account signing needs nothing from
// either side but the caller's own import configuration (plan §2.3b).
// Also the operator-attested rows (`Nats-Request-Info` cross-check on a
// receiver that declared its endpoint closed) and the `resolveSender`
// reverse lookup end to end.

import { readFile } from "node:fs/promises";
import {
  Empty,
  headers,
  nkeyAuthenticator,
  NoRespondersError,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
} from "@nats-io/nats-core";
import { Svcm } from "@nats-io/services";
import { connect } from "@nats-io/transport-node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ReferenceAgent } from "@synadia-ai/agent-service/testing";
import {
  AGENT_SENDER_HEADER,
  Agents,
  base64UrlEncode,
  formatSender,
  IDENTITY_METADATA_KEYS,
  InvalidAgentIdError,
  MIN_SENDER_TRUST_KEY,
  NATS_REQUEST_INFO_HEADER,
  newAgentId,
  parseSenderHeader,
  readSenderHeaderValue,
  resolveSender,
  SenderResolver,
  SenderVerificationError,
  serializeSenderHeader,
  ServiceError,
  signerFromSeed,
  signSenderHeader,
  verifySenderHeader,
  type AgentInfo,
  type SenderInfo,
  type StreamMessage,
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
const PAYLOAD = enc.encode('{"prompt":"hi"}');

function user(name: string): { public: string; seed: string } {
  const u = keys.users[name];
  if (!u) throw new Error(`no fixture user ${name}`);
  return u;
}

function connectAs(url: string, name: string): Promise<NatsConnection> {
  return connect({
    servers: url,
    authenticator: nkeyAuthenticator(enc.encode(user(name).seed)),
    reconnect: false,
  });
}

async function drain(stream: AsyncIterable<StreamMessage>): Promise<StreamMessage[]> {
  const out: StreamMessage[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

async function streamError(p: Promise<AsyncIterable<StreamMessage>>): Promise<unknown> {
  try {
    await drain(await p);
    return null;
  } catch (err) {
    return err;
  }
}

function withHeader(value: string, name = AGENT_SENDER_HEADER): MsgHdrs {
  const h = headers();
  h.set(name, value);
  return h;
}

async function rawPrompt(
  nc: NatsConnection,
  subject: string,
  payload: Uint8Array,
  hdrs?: MsgHdrs,
): Promise<Msg[]> {
  const out: Msg[] = [];
  const iter = await nc.requestMany(subject, payload, {
    strategy: "sentinel",
    maxWait: 3_000,
    ...(hdrs ? { headers: hdrs } : {}),
  });
  for await (const m of iter) out.push(m);
  return out;
}

const errorCode = (msgs: Msg[]): string | undefined =>
  msgs[0]?.headers?.get("Nats-Service-Error-Code") || undefined;

describe.skipIf(!bin)("identity T2/T3/T4 — accounts.conf", () => {
  const server = new NatsServerProcess();
  const conns = new Map<string, NatsConnection>();
  interface Seen {
    readonly sender: SenderInfo | undefined;
    readonly requestInfo: string | undefined;
    /** Set by the `resolving` agent's handler only. */
    readonly resolved?: AgentInfo | undefined;
  }
  const seen: Seen[] = [];
  let ref: ReferenceAgent;
  let sibling: ReferenceAgent;
  let attested: ReferenceAgent;
  let resolving: ReferenceAgent;
  let aliceAgent: ReferenceAgent;
  let srvInfoRequests = 0;
  let tamperedStop: (() => Promise<void>) | undefined;
  const perTest: Array<() => Promise<void>> = [];
  const perTestGlobal: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("accounts.conf") });
    for (const name of ["alice", "bob", "carol", "dave", "erin"]) {
      conns.set(name, await connectAs(server.url, name));
    }
    const handler = (msg: Msg, sender: SenderInfo | undefined): void => {
      seen.push({ sender, requestInfo: msg.headers?.get("Nats-Request-Info") || undefined });
      for (const text of ["one", "two", "three"]) {
        msg.respond(enc.encode(JSON.stringify({ type: "response", data: text })));
      }
      msg.respond(Empty);
    };
    // The agent is hosted by carol (ACME); alice (ACME) is the same-account caller.
    ref = new ReferenceAgent({
      nc: conns.get("carol")!,
      agent: "acme-agent",
      owner: "acme",
      name: "main",
      identity: { signer: signerFromSeed(user("carol").seed) },
      promptHandler: handler,
    });
    await ref.start();
    sibling = new ReferenceAgent({
      nc: conns.get("carol")!,
      agent: "acme-agent",
      owner: "acme",
      name: "sibling",
      promptHandler: handler,
    });
    await sibling.start();
    // Operator-attested receiver: the deployment "declared the endpoint
    // closed" — for the test, ACME's own users are the forgers.
    attested = new ReferenceAgent({
      nc: conns.get("carol")!,
      agent: "acme-agent",
      owner: "acme",
      name: "attested",
      identity: { signer: signerFromSeed(user("carol").seed) },
      operatorAttested: true,
      promptHandler: handler,
    });
    await attested.start();
    // Reverse lookup from inside a handler: `sender.resolve()` is bound to
    // carol's connection (ACME), so it sees ACME registrations only.
    resolving = new ReferenceAgent({
      nc: conns.get("carol")!,
      agent: "acme-agent",
      owner: "acme",
      name: "resolving",
      promptHandler: async (msg, sender) => {
        const resolved = sender?.trust === "verified" ? await sender.resolve() : undefined;
        seen.push({
          sender,
          requestInfo: msg.headers?.get("Nats-Request-Info") || undefined,
          resolved,
        });
        msg.respond(
          enc.encode(
            JSON.stringify({
              type: "response",
              data: resolved ? resolved.promptEndpoint.subject : "unresolved",
            }),
          ),
        );
        msg.respond(Empty);
      },
    });
    await resolving.start();
    // alice registers an agent of her own (with a signer → `id_sig`), so
    // her ID resolves to it.
    aliceAgent = new ReferenceAgent({
      nc: conns.get("alice")!,
      agent: "alice-agent",
      owner: "acme",
      name: "own",
      identity: { signer: signerFromSeed(user("alice").seed) },
    });
    await aliceAgent.start();
    // An imposter: a hand-registered service claiming bob's key under ACME
    // with an `id_sig` that does not verify — the reverse lookup must drop it.
    const imposter = await new Svcm(conns.get("carol")!).add({
      name: "agents",
      version: "0.0.1",
      metadata: {
        agent: "acme-agent",
        owner: "acme",
        protocol_version: "0.3",
        [IDENTITY_METADATA_KEYS.userNkey]: user("bob").public,
        [IDENTITY_METADATA_KEYS.account]: "ACME",
        [IDENTITY_METADATA_KEYS.idSig]: base64UrlEncode(new Uint8Array(64)),
      },
    });
    imposter.addEndpoint("prompt", {
      subject: "agents.prompt.acme-agent.acme.imposter",
      queue: "agents",
      handler: (err, msg) => {
        if (!err) msg.respond(Empty);
      },
      metadata: { [MIN_SENDER_TRUST_KEY]: "any" },
    });
    tamperedStop = () => imposter.stop().then(() => undefined);
    // Count `$SRV.INFO.agents` enumerations reaching ACME (from any account).
    const spy = conns.get("carol")!.subscribe("$SRV.INFO.agents", {
      callback: () => {
        srvInfoRequests++;
      },
    });
    perTestGlobal.push(() => Promise.resolve(spy.unsubscribe()));
    await conns.get("carol")!.flush();
  });

  afterEach(async () => {
    for (const c of perTest.splice(0).reverse()) await c();
  });

  afterAll(async () => {
    for (const c of perTestGlobal.splice(0).reverse()) await c();
    await tamperedStop?.();
    await aliceAgent.stop();
    await resolving.stop();
    await attested.stop();
    await ref.stop();
    await sibling.stop();
    for (const nc of conns.values()) await nc.close();
    await server.stop();
  });

  function agentsFor(name: string, resolveTtlMs?: number): Agents {
    const agents = new Agents({
      nc: conns.get(name)!,
      identity: { signer: signerFromSeed(user(name).seed), name },
      ...(resolveTtlMs !== undefined ? { resolveTtlMs } : {}),
    });
    perTest.push(() => agents.close());
    return agents;
  }

  async function discoverByName(agents: Agents, name: string) {
    const [agent] = await agents.discover({
      timeoutMs: 800,
      filter: { agent: "acme-agent", name },
    });
    if (!agent) throw new Error(`acme-agent/${name} not discovered`);
    return agent;
  }

  const discoverMain = (agents: Agents) => discoverByName(agents, "main");

  /** Wait until the spy has counted at least `n` `$SRV.INFO.agents` requests. */
  async function srvInfoCountAtLeast(n: number): Promise<number> {
    const deadline = Date.now() + 2_000;
    while (srvInfoRequests < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return srvInfoRequests;
  }

  it("T2 same account: selfId is ACME.<user>; alice → carol's agent verifies; a forged Nats-Request-Info is ignored", async () => {
    const alice = agentsFor("alice");
    expect(await alice.selfId()).toBe(newAgentId("ACME", user("alice").public));
    const agent = await discoverMain(alice);
    expect(agent.identity).toBe(newAgentId("ACME", user("carol").public));
    expect(agent.idSigVerified).toBe(true);
    const events = await drain(await agent.prompt("hi"));
    expect(events.filter((e) => e.type === "response")).toHaveLength(3);
    expect(seen.at(-1)?.sender).toMatchObject({
      trust: "verified",
      id: newAgentId("ACME", user("alice").public),
      accountAttested: false,
    });

    // Forged header from the same account: the SDK never reads Nats-Request-Info in this mode.
    const h = await signSenderHeader({
      signer: signerFromSeed(user("alice").seed),
      id: newAgentId("ACME", user("alice").public),
      sub: ref.promptSubject,
      payload: PAYLOAD,
    });
    const forged = withHeader(serializeSenderHeader(h));
    forged.set("Nats-Request-Info", JSON.stringify({ acc: "EVIL", user: user("bob").public }));
    expect(
      errorCode(await rawPrompt(conns.get("alice")!, ref.promptSubject, PAYLOAD, forged)),
    ).toBeUndefined();
    expect(seen.at(-1)?.requestInfo).toMatch(/EVIL/);
    expect(seen.at(-1)?.sender).toMatchObject({ trust: "verified", accountAttested: false });
  });

  it("T3 cross-account with share: bob (APP) discovers through the exported $SRV.>, prompt() signs the discovered subject, 3 chunks stream back, pair APP.<bob>; the server stamps Nats-Request-Info", async () => {
    const bob = agentsFor("bob");
    expect(await bob.selfId()).toBe(newAgentId("APP", user("bob").public));
    const agent = await discoverMain(bob);
    const events = await drain(await agent.prompt("hi"));
    expect(
      events.filter((e) => e.type === "response").map((e) => (e as { text: string }).text),
    ).toEqual(["one", "two", "three"]);
    const last = seen.at(-1)!;
    expect(last.sender).toMatchObject({
      trust: "verified",
      id: newAgentId("APP", user("bob").public),
      name: "bob",
    });
    expect(last.requestInfo).toBeDefined();
    const info = JSON.parse(last.requestInfo!) as { acc: string; user?: string };
    expect(info.acc).toBe("APP");
    expect(info.user).toBe(user("bob").public);
    expect(formatSender(last.sender)).toBe(
      `APP.${user("bob").public} (verified user, claimed account)`,
    );
    expect(await agent.status()).toMatchObject({ agent: "acme-agent", instanceId: ref.instanceId });
  });

  it("T4 cross-account without share: dave (APP2) verifies; Nats-Request-Info carries acc only", async () => {
    const dave = agentsFor("dave");
    const agent = await discoverMain(dave);
    await drain(await agent.prompt("hi"));
    const last = seen.at(-1)!;
    expect(last.sender).toMatchObject({
      trust: "verified",
      id: newAgentId("APP2", user("dave").public),
    });
    expect(last.requestInfo).toBeDefined();
    const info = JSON.parse(last.requestInfo!) as { acc: string; user?: string };
    expect(info.acc).toBe("APP2");
    expect(info.user).toBeUndefined();
  });

  it("T3 remapped import (erin, APP3): publish the local name, sign the exporter's subject → verified with no receiver configuration", async () => {
    const erin = agentsFor("erin");
    const agent = await discoverMain(erin);
    const local = `local.${ref.promptSubject}`;
    const events = await drain(
      await agent.prompt("hi", { subject: local, sub: agent.promptEndpoint.subject }),
    );
    expect(events.filter((e) => e.type === "response")).toHaveLength(3);
    expect(seen.at(-1)?.sender).toMatchObject({
      trust: "verified",
      id: newAgentId("APP3", user("erin").public),
    });
    expect(seen.at(-1)?.sender?.header.sub).toBe(ref.promptSubject);

    // Signing the local name instead → 401 with the generic description.
    const err = await streamError(agent.prompt("hi", { subject: local }));
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(401);
    expect((err as ServiceError).description).toBe("sender rejected");

    // A header signed for the sibling's subject re-presented here → 401.
    const forSibling = await signSenderHeader({
      signer: signerFromSeed(user("erin").seed),
      id: newAgentId("APP3", user("erin").public),
      sub: sibling.promptSubject,
      payload: PAYLOAD,
    });
    expect(
      errorCode(
        await rawPrompt(
          conns.get("erin")!,
          local,
          PAYLOAD,
          withHeader(serializeSenderHeader(forSibling)),
        ),
      ),
    ).toBe("401");

    // Without an override the discovered subject has no interest in APP3 → NoRespondersError.
    const noOverride = await streamError(agent.prompt("hi"));
    expect(noOverride).toBeDefined();
    const isNoResponders =
      noOverride instanceof NoRespondersError ||
      (noOverride as { cause?: unknown })?.cause instanceof NoRespondersError ||
      /no responders/i.test(String((noOverride as Error).message));
    expect(isNoResponders).toBe(true);

    // status() takes the same overrides.
    const statusLocal = `local.${ref.statusSubject}`;
    const hb = await agent.status({ subject: statusLocal, sub: ref.statusSubject });
    expect(hb.instanceId).toBe(ref.instanceId);
  });

  it("operator-attested (T2): a forged Nats-Request-Info from a same-account user → 401; no stamp at all → verified but not attested", async () => {
    const alice = agentsFor("alice");
    const agent = await discoverByName(alice, "attested");
    // Same-account traffic carries no stamp: compared to nothing.
    await drain(await agent.prompt("hi"));
    expect(seen.at(-1)?.requestInfo).toBeUndefined();
    expect(seen.at(-1)?.sender).toMatchObject({
      trust: "verified",
      id: newAgentId("ACME", user("alice").public),
      accountAttested: false,
    });

    const h = await signSenderHeader({
      signer: signerFromSeed(user("alice").seed),
      id: newAgentId("ACME", user("alice").public),
      sub: attested.promptSubject,
      payload: PAYLOAD,
    });
    const forged = withHeader(serializeSenderHeader(h));
    forged.set(NATS_REQUEST_INFO_HEADER, JSON.stringify({ acc: "APP", user: user("bob").public }));
    const before = seen.length;
    const msgs = await rawPrompt(conns.get("alice")!, attested.promptSubject, PAYLOAD, forged);
    expect(errorCode(msgs)).toBe("401");
    expect(msgs[0]?.headers?.get("Nats-Service-Error")).toBe("sender rejected");
    expect(seen).toHaveLength(before); // never reached the handler

    // A stamp that agrees with the signature attests the account — here the
    // "stamp" is written by alice herself: exactly why the mode is a
    // deployment promise the SDK cannot verify. `h` is reusable: the forged
    // request was refused before its nonce was recorded.
    const selfStamped = withHeader(serializeSenderHeader(h));
    selfStamped.set(NATS_REQUEST_INFO_HEADER, JSON.stringify({ acc: "ACME" }));
    expect(
      errorCode(await rawPrompt(conns.get("alice")!, attested.promptSubject, PAYLOAD, selfStamped)),
    ).toBeUndefined();
    expect(seen.at(-1)?.sender).toMatchObject({ trust: "verified", accountAttested: true });
  });

  it("operator-attested (T3/T4): the server stamp agrees → accountAttested=true and formatSender renders `(verified)` — with `user` (share) and with `acc` only (no share)", async () => {
    const bob = agentsFor("bob");
    await drain(await (await discoverByName(bob, "attested")).prompt("hi"));
    const viaShare = seen.at(-1)!;
    expect(JSON.parse(viaShare.requestInfo!)).toMatchObject({
      acc: "APP",
      user: user("bob").public,
    });
    expect(viaShare.sender).toMatchObject({
      trust: "verified",
      id: newAgentId("APP", user("bob").public),
      accountAttested: true,
    });
    expect(formatSender(viaShare.sender)).toBe(`APP.${user("bob").public} (verified)`);

    const dave = agentsFor("dave");
    await drain(await (await discoverByName(dave, "attested")).prompt("hi"));
    const accOnly = seen.at(-1)!;
    expect(JSON.parse(accOnly.requestInfo!)).toMatchObject({ acc: "APP2" });
    expect((JSON.parse(accOnly.requestInfo!) as { user?: string }).user).toBeUndefined();
    expect(accOnly.sender).toMatchObject({
      trust: "verified",
      id: newAgentId("APP2", user("dave").public),
      accountAttested: true,
    });

    // The same requests against the plain receiver stay "claimed account".
    await drain(await (await discoverMain(bob)).prompt("hi"));
    expect(seen.at(-1)?.sender).toMatchObject({ trust: "verified", accountAttested: false });
  });

  it("resolveSender end to end: a handler resolves the prompt sender to her registration; an imposter with a bad id_sig is dropped; unknown key → undefined; a second call within the TTL hits the cache", async () => {
    const alice = agentsFor("alice");
    const aliceId = newAgentId("ACME", user("alice").public);
    const agent = await discoverByName(alice, "resolving");

    // Host side: `sender.resolve()` inside the handler → alice's own agent.
    const start = await srvInfoCountAtLeast(0);
    const first = await drain(await agent.prompt("who am I?"));
    expect((first.find((e) => e.type === "response") as { text: string }).text).toBe(
      aliceAgent.promptSubject,
    );
    const resolved = seen.at(-1)?.resolved;
    expect(resolved).toBeDefined();
    expect(resolved?.identity).toBe(aliceId);
    expect(resolved?.idSigVerified).toBe(true);
    expect(resolved?.instanceId).toBe(aliceAgent.instanceId);
    const afterFirst = await srvInfoCountAtLeast(start + 1);
    expect(afterFirst).toBe(start + 1);
    // Second prompt within the 10 s TTL: no new enumeration.
    await drain(await agent.prompt("again"));
    expect(seen.at(-1)?.resolved?.instanceId).toBe(aliceAgent.instanceId);
    await new Promise((r) => setTimeout(r, 100));
    expect(srvInfoRequests).toBe(afterFirst);

    // Caller side: `Agents.resolveSender` with the default TTL, then with TTL 0.
    const before = srvInfoRequests;
    expect((await alice.resolveSender(aliceId))?.instanceId).toBe(aliceAgent.instanceId);
    expect((await alice.resolveSender(String(aliceId)))?.instanceId).toBe(aliceAgent.instanceId);
    expect(await srvInfoCountAtLeast(before + 1)).toBe(before + 1);
    const uncached = agentsFor("carol", 0);
    await uncached.resolveSender(aliceId);
    await uncached.resolveSender(aliceId);
    expect(await srvInfoCountAtLeast(before + 3)).toBe(before + 3);

    // The imposter claims bob's key under ACME with a bad id_sig → dropped;
    // erin's key is registered nowhere → undefined.
    expect(await alice.resolveSender(newAgentId("ACME", user("bob").public))).toBeUndefined();
    expect(await alice.resolveSender(newAgentId("ACME", user("erin").public))).toBeUndefined();
    // The imposter is still *discoverable* — it is only the verified index that drops it.
    const found = await alice.discover({ timeoutMs: 800, filter: { name: "imposter" } });
    expect(found).toHaveLength(1);
    expect(found[0]?.identity).toBe(newAgentId("ACME", user("bob").public));
    expect(found[0]?.idSigVerified).toBe(false);

    // Module-level uncached form and the resolver class directly.
    expect((await resolveSender(conns.get("carol")!, aliceId))?.instanceId).toBe(
      aliceAgent.instanceId,
    );
    const resolver = new SenderResolver(conns.get("carol")!, { ttlMs: 60_000 });
    expect((await resolver.resolve(aliceId))?.instanceId).toBe(aliceAgent.instanceId);
    resolver.invalidate();
    expect((await resolver.resolve(aliceId))?.instanceId).toBe(aliceAgent.instanceId);
    expect(resolver.ttlMs).toBe(60_000);
    await expect(resolver.resolve("not-an-id")).rejects.toBeInstanceOf(InvalidAgentIdError);
  });

  it("resolveSender is account-local: bob (APP) resolves an ACME agent through the exported $SRV.>, but ACME cannot resolve bob", async () => {
    const bob = agentsFor("bob");
    const carolId = newAgentId("ACME", user("carol").public);
    expect((await bob.resolveSender(carolId))?.identity).toBe(carolId);
    const carol = agentsFor("carol");
    expect(await carol.resolveSender(newAgentId("APP", user("bob").public))).toBeUndefined();
    // Bob prompting the resolving agent: verified, but not a reachable agent from ACME's view.
    const events = await drain(await (await discoverByName(bob, "resolving")).prompt("hi"));
    expect((events.find((e) => e.type === "response") as { text: string }).text).toBe("unresolved");
  });
});

describe.skipIf(!bin)("identity T3 — account_token_position (account-token-position.conf)", () => {
  const server = new NatsServerProcess();
  const conns = new Map<string, NatsConnection>();
  const perTest: Array<() => Promise<void>> = [];
  let svcStop: (() => Promise<void>) | undefined;
  const arrivals: string[] = [];

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("account-token-position.conf") });
    for (const name of ["alice", "bob", "dave"]) conns.set(name, await connectAs(server.url, name));

    // A hand-rolled service on `svc.*.prompt` (AgentService cannot host a
    // six-token inserted subject, plan §2.3b): it verifies the header with
    // `accountTokenPosition: 2` and answers the classification result.
    const svc = await new Svcm(conns.get("alice")!).add({ name: "atp", version: "0.0.1" });
    svc.addEndpoint("prompt", {
      subject: "svc.*.prompt",
      handler: (err, msg) => {
        if (err) return;
        arrivals.push(msg.subject);
        const position = Number(msg.headers?.get("X-Test-Position") || "2");
        void (async (): Promise<void> => {
          try {
            const value = readSenderHeaderValue(msg.headers);
            const header = value === undefined ? null : parseSenderHeader(value);
            if (!header) {
              msg.respond(enc.encode("no sender"));
              return;
            }
            const sender = await verifySenderHeader(header, msg.subject, msg.data, {
              mode: "live",
              accountTokenPosition: position,
            });
            msg.respond(enc.encode(formatSender(sender)));
          } catch (e) {
            const code = e instanceof SenderVerificationError ? e.code : 400;
            msg.respondError(code, e instanceof Error ? e.message.slice(0, 120) : "error");
          }
        })();
      },
    });
    svcStop = () => svc.stop().then(() => undefined);
    await conns.get("alice")!.flush(); // SUBs at the server before the first request
  });

  afterEach(async () => {
    for (const c of perTest.splice(0).reverse()) await c();
  });

  afterAll(async () => {
    await svcStop?.();
    for (const nc of conns.values()) await nc.close();
    await server.stop();
  });

  function agentsFor(name: string): Agents {
    const agents = new Agents({
      nc: conns.get(name)!,
      identity: { signer: signerFromSeed(user(name).seed) },
    });
    perTest.push(() => agents.close());
    return agents;
  }

  const verifiedLine = (account: string, name: string): string =>
    `${account}.${user(name).public} (verified user, claimed account)`;

  it("bob signs what he publishes (`svc.prompt`, import with `to`): arrival `svc.APP.prompt`, token = account, removal = sub → verified", async () => {
    const bob = agentsFor("bob");
    const reply = await bob.requestSigned("svc.prompt", PAYLOAD);
    expect(reply.string()).toBe(verifiedLine("APP", "bob"));
    expect(arrivals.at(-1)).toBe("svc.APP.prompt");
  });

  it("bob via the plain import signs the token-bearing subject: equality branch, cross-check still runs → verified", async () => {
    const bob = agentsFor("bob");
    const reply = await bob.requestSigned("svc.APP.prompt", PAYLOAD);
    expect(reply.string()).toBe(verifiedLine("APP", "bob"));
  });

  it("a forged account in the header → 401 (the inserted token disagrees)", async () => {
    const h = await signSenderHeader({
      signer: signerFromSeed(user("bob").seed),
      id: newAgentId("EVIL", user("bob").public),
      sub: "svc.prompt",
      payload: PAYLOAD,
    });
    const reply = await conns.get("bob")!.request("svc.prompt", PAYLOAD, {
      timeout: 2_000,
      headers: withHeader(serializeSenderHeader(h)),
    });
    expect(reply.headers?.get("Nats-Service-Error-Code")).toBe("401");
  });

  it("dave (APP2, no share) publishes `svc.APP2.prompt` → verified", async () => {
    const dave = agentsFor("dave");
    const reply = await dave.requestSigned("svc.APP2.prompt", PAYLOAD);
    expect(reply.string()).toBe(verifiedLine("APP2", "dave"));
  });

  it("an open endpoint: a same-account ACME user publishing `svc.EVIL.prompt` with account EVIL verifies (documented precondition; accountAttested stays false)", async () => {
    const h = await signSenderHeader({
      signer: signerFromSeed(user("alice").seed),
      id: newAgentId("EVIL", user("alice").public),
      sub: "svc.EVIL.prompt",
      payload: PAYLOAD,
    });
    const reply = await conns.get("alice")!.request("svc.EVIL.prompt", PAYLOAD, {
      timeout: 2_000,
      headers: withHeader(serializeSenderHeader(h)),
    });
    expect(reply.string()).toBe(verifiedLine("EVIL", "alice"));
  });

  it("position 5 on a 3-token arrival subject → 401, never an index error", async () => {
    const h = await signSenderHeader({
      signer: signerFromSeed(user("bob").seed),
      id: newAgentId("APP", user("bob").public),
      sub: "svc.prompt",
      payload: PAYLOAD,
    });
    const hdrs = withHeader(serializeSenderHeader(h));
    hdrs.set("X-Test-Position", "5");
    const reply = await conns
      .get("bob")!
      .request("svc.prompt", PAYLOAD, { timeout: 2_000, headers: hdrs });
    expect(reply.headers?.get("Nats-Service-Error-Code")).toBe("401");
  });
});

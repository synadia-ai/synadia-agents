// Host-side identity rows (plan §6.4 T0 / T1) through `AgentService`:
// registration metadata, classification before the ack, `min_sender_trust`,
// the acceptance hook, `status` classify-only, the `PromptResponse.sender`
// shape the harness sees; and on `accounts.conf` the operator-attested
// cross-check plus `response.sender.resolve()` (T2 / T3).

import { readFile } from "node:fs/promises";
import {
  Empty,
  headers,
  nkeyAuthenticator,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
} from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_SENDER_HEADER,
  Agents,
  buildClaimHeader,
  formatSender,
  IDENTITY_METADATA_KEYS,
  IdentityMismatchError,
  MIN_SENDER_TRUST_KEY,
  NATS_REQUEST_INFO_HEADER,
  newAgentId,
  serializeSenderHeader,
  type ServiceError,
  signerFromSeed,
  signSenderHeader,
  USER_INFO_SUBJECT,
  verifyAgentId,
  type AgentInfo,
  type Logger,
  type SenderInfo,
  type StreamMessage,
} from "@synadia-ai/agents";
import { AgentService, type AgentServiceOptions } from "../../src/service.js";
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
const BOB = keys.users["bob"]!;
const PAYLOAD = enc.encode('{"prompt":"hi"}');

interface LogLine {
  readonly level: string;
  readonly msg: string;
  readonly ctx: Record<string, unknown> | undefined;
}

function capturingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const push =
    (level: string) =>
    (msg: string, ctx?: Record<string, unknown>): void => {
      lines.push({ level, msg, ctx });
    };
  return {
    lines,
    logger: { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") },
  };
}

function connectAs(url: string, seed: string): Promise<NatsConnection> {
  return connect({
    servers: url,
    authenticator: nkeyAuthenticator(enc.encode(seed)),
    reconnect: false,
  });
}

function withHeader(value: string): MsgHdrs {
  const h = headers();
  h.set(AGENT_SENDER_HEADER, value);
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

async function drain(stream: AsyncIterable<StreamMessage>): Promise<StreamMessage[]> {
  const out: StreamMessage[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!bin)("AgentService — sender identity (nkey user, $G)", () => {
  const server = new NatsServerProcess();
  let hostNc: NatsConnection;
  let callerNc: NatsConnection;
  const perTest: Array<() => Promise<void>> = [];
  const aliceSigner = signerFromSeed(ALICE.seed);
  const ALICE_ID = newAgentId("$G", ALICE.public);

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf") });
    hostNc = await connectAs(server.url, ALICE.seed);
    callerNc = await connectAs(server.url, ALICE.seed);
  });

  afterEach(async () => {
    for (const c of perTest.splice(0).reverse()) await c();
  });

  afterAll(async () => {
    await hostNc.close();
    await callerNc.close();
    await server.stop();
  });

  interface Started {
    readonly service: AgentService;
    readonly senders: Array<SenderInfo | undefined>;
    readonly lines: LogLine[];
  }

  async function startService(overrides: Partial<AgentServiceOptions> = {}): Promise<Started> {
    const senders: Array<SenderInfo | undefined> = [];
    const { logger, lines } = capturingLogger();
    const service = new AgentService({
      nc: hostNc,
      agent: "id-svc",
      owner: "testers",
      name: `inst-${Math.random().toString(36).slice(2, 8)}`,
      heartbeatIntervalS: 1,
      keepaliveIntervalS: null,
      identity: { signer: aliceSigner },
      logger,
      ...overrides,
    });
    service.onPrompt(async (_env, response) => {
      senders.push(response.sender);
      await response.send(`echo from ${formatSender(response.sender)}`);
    });
    await service.start();
    perTest.push(() => service.stop());
    return { service, senders, lines };
  }

  function client(identity?: ConstructorParameters<typeof Agents>[0]["identity"]): Agents {
    const agents = new Agents({ nc: callerNc, ...(identity ? { identity } : {}) });
    perTest.push(() => agents.close());
    return agents;
  }

  async function discover(agents: Agents, service: AgentService) {
    const [agent] = await agents.discover({
      timeoutMs: 800,
      filter: { agent: "id-svc", name: service.subject.name },
    });
    if (!agent) throw new Error("not discovered");
    return agent;
  }

  it("registers user_nkey / account / id_sig (over the prompt subject) and always min_sender_trust; identity keys win over extraMetadata", async () => {
    const { service } = await startService({
      extraMetadata: { [IDENTITY_METADATA_KEYS.userNkey]: BOB.public, custom: "kept" },
    });
    expect(service.identity).toBe(ALICE_ID);
    const agent = await discover(client(), service);
    expect(agent.metadata[IDENTITY_METADATA_KEYS.userNkey]).toBe(ALICE.public);
    expect(agent.metadata[IDENTITY_METADATA_KEYS.account]).toBe("$G");
    expect(agent.metadata["custom"]).toBe("kept");
    expect(verifyAgentId(agent.metadata, service.subject.prompt)).toBe(true);
    expect(agent.idSigVerified).toBe(true);
    expect(agent.promptEndpoint.metadata[MIN_SENDER_TRUST_KEY]).toBe("any");
    const status = agent.endpoints.find((e) => e.name === "status")!;
    expect(status.metadata[MIN_SENDER_TRUST_KEY]).toBeUndefined();
  });

  it("omitted host identity does no lookup, strips spoofed metadata, and still classifies inbound senders", async () => {
    const nc = await connectAs(server.url, ALICE.seed);
    perTest.push(() => nc.close());
    const probes: Msg[] = [];
    const probeSub = nc.subscribe(USER_INFO_SUBJECT, {
      callback: (_err, msg) => {
        probes.push(msg);
      },
    });
    perTest.push(() => {
      probeSub.unsubscribe();
      return Promise.resolve();
    });
    await nc.flush();

    let received: SenderInfo | undefined;
    const service = new AgentService({
      nc,
      agent: "id-svc",
      owner: "testers",
      name: "identity-off",
      heartbeatIntervalS: 1,
      keepaliveIntervalS: null,
      extraMetadata: {
        [IDENTITY_METADATA_KEYS.userNkey]: BOB.public,
        [IDENTITY_METADATA_KEYS.account]: "FORGED",
        [IDENTITY_METADATA_KEYS.idSig]: "FORGED",
      },
    });
    service.onPrompt(async (_env, response) => {
      received = response.sender;
      await response.send("ok");
    });
    await service.start();
    perTest.push(() => service.stop());
    await nc.flush();
    expect(probes).toHaveLength(0);
    expect(service.identity).toBeUndefined();
    probeSub.unsubscribe();

    const signed = client({ signer: aliceSigner });
    const agent = await discover(signed, service);
    expect(agent.metadata[IDENTITY_METADATA_KEYS.userNkey]).toBeUndefined();
    expect(agent.metadata[IDENTITY_METADATA_KEYS.account]).toBeUndefined();
    expect(agent.metadata[IDENTITY_METADATA_KEYS.idSig]).toBeUndefined();
    await drain(await agent.prompt("hi"));
    expect(received?.trust).toBe("verified");
  });

  it("start() throws IdentityMismatchError for a foreign signer", async () => {
    const nc = await connectAs(server.url, ALICE.seed);
    perTest.push(() => nc.close());
    const svc = new AgentService({
      nc,
      agent: "id-svc",
      owner: "testers",
      name: "mismatch",
      identity: { signer: signerFromSeed(BOB.seed) },
    });
    svc.onPrompt(async () => {});
    await expect(svc.start()).rejects.toBeInstanceOf(IdentityMismatchError);
  });

  it("the handler sees a VerifiedSender (with id) for a signed prompt, a ClaimedSender (no id) for a claim, undefined for none", async () => {
    const { service, senders } = await startService();
    const signed = client({ signer: aliceSigner, name: "signer" });
    const events = await drain(await (await discover(signed, service)).prompt("hi"));
    // events[0] is the §6.4 leading `ack`; the echo is the first response chunk.
    const echo = events.find((e) => e.type === "response");
    expect((echo as { text: string }).text).toBe(
      `echo from ${ALICE_ID} (verified user, claimed account)`,
    );
    expect(senders[0]).toMatchObject({
      trust: "verified",
      id: ALICE_ID,
      name: "signer",
      accountAttested: false,
    });

    await drain(await (await discover(client({}), service)).prompt("hi"));
    expect(senders[1]?.trust).toBe("claimed");
    expect(senders[1] && "id" in senders[1]).toBe(false);

    expect(errorCode(await rawPrompt(callerNc, service.subject.prompt, PAYLOAD))).toBeUndefined();
    expect(senders[2]).toBeUndefined();
  });

  it("min_sender_trust=signed: claim → 401 'signature required'; header-less → 401; signed → served", async () => {
    const { service, senders } = await startService({ minSenderTrust: "signed" });
    const claim = serializeSenderHeader(buildClaimHeader({ id: ALICE_ID }));
    const msgs = await rawPrompt(callerNc, service.subject.prompt, PAYLOAD, withHeader(claim));
    expect(errorCode(msgs)).toBe("401");
    expect(msgs[0]?.headers?.get("Nats-Service-Error")).toBe("signature required");
    expect(msgs.at(-1)?.data.length).toBe(0);
    expect(errorCode(await rawPrompt(callerNc, service.subject.prompt, PAYLOAD))).toBe("401");
    await drain(await (await discover(client({ signer: aliceSigner }), service)).prompt("hi"));
    expect(senders).toHaveLength(1);
  });

  it("classification happens before the ack: a rejected request yields exactly an error frame and a terminator", async () => {
    const { service, senders } = await startService();
    const h = await signSenderHeader({
      signer: aliceSigner,
      id: ALICE_ID,
      sub: service.subject.prompt,
      payload: PAYLOAD,
    });
    const value = serializeSenderHeader(h);
    expect(
      errorCode(await rawPrompt(callerNc, service.subject.prompt, PAYLOAD, withHeader(value))),
    ).toBeUndefined();
    // nats-core's sentinel strategy ends on the first empty-body message —
    // the error frame itself — so the §9.3 terminator behind it is not
    // observable here; what matters is that no chunk precedes the error.
    const replay = await rawPrompt(callerNc, service.subject.prompt, PAYLOAD, withHeader(value));
    expect(replay).toHaveLength(1);
    expect(replay[0]?.headers?.get("Nats-Service-Error-Code")).toBe("401");
    expect(replay[0]?.data.length).toBe(0);
    expect(senders).toHaveLength(1);
    expect(
      errorCode(await rawPrompt(callerNc, service.subject.prompt, PAYLOAD, withHeader("{bad"))),
    ).toBe("400");
  });

  it("acceptSender: 403 for a refused verified sender, 401 for a refused claim / absent sender, 500 when it throws; runs after classification and before the ack", async () => {
    const seenByHook: Array<SenderInfo | undefined> = [];
    const refusing = await startService({
      acceptSender: (s) => {
        seenByHook.push(s);
        return false;
      },
    });
    const signed = client({ signer: aliceSigner });
    const e403 = await drain(await (await discover(signed, refusing.service)).prompt("hi")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((e403 as ServiceError).code).toBe(403);
    const e401 = await drain(
      await (await discover(client({}), refusing.service)).prompt("hi"),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect((e401 as ServiceError).code).toBe(401);
    expect(errorCode(await rawPrompt(callerNc, refusing.service.subject.prompt, PAYLOAD))).toBe(
      "401",
    );
    expect(seenByHook.map((s) => s?.trust)).toEqual(["verified", "claimed", undefined]);
    expect(refusing.senders).toHaveLength(0);
    expect(refusing.lines.filter((l) => l.level === "warn")).toHaveLength(3);

    let secretFromHeader = "";
    const throwing = await startService({
      acceptSender: (sender) => {
        secretFromHeader = sender?.trust === "verified" ? sender.header.nonce! : "unexpected";
        const error = new Error(secretFromHeader);
        error.name = secretFromHeader;
        return Promise.reject(error);
      },
    });
    const e500 = await drain(await (await discover(signed, throwing.service)).prompt("hi")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((e500 as ServiceError).code).toBe(500);
    expect(throwing.senders).toHaveLength(0);
    expect(throwing.lines.some((l) => l.level === "error" && /acceptSender/.test(l.msg))).toBe(
      true,
    );
    expect(secretFromHeader).not.toBe("");
    expect(JSON.stringify(throwing.lines)).not.toContain(secretFromHeader);
  });

  it("status: classified and logged, never rejected — a failing classification is a warning", async () => {
    const { service, lines } = await startService();
    const agent = await discover(client({ signer: aliceSigner }), service);
    expect((await agent.status()).instanceId).toBe(service.instanceId);
    await sleep(50);
    expect(lines.find((l) => l.msg === "status request")?.ctx?.["sender"]).toBe(
      `${ALICE_ID} (verified user, claimed account)`,
    );
    const reply = await callerNc.request(service.subject.status, Empty, {
      timeout: 2_000,
      headers: withHeader("{bad"),
    });
    expect(reply.headers?.get("Nats-Service-Error-Code") || undefined).toBeUndefined();
    await sleep(50);
    expect(
      lines.some(
        (l) => l.level === "warn" && /status request/.test(l.msg) && l.ctx?.["code"] === 400,
      ),
    ).toBe(true);
  });

  it("option validation: minSenderTrust, replayWindowMs, accountTokenPosition, resolveTtlMs, operatorAttested", () => {
    const base = { nc: hostNc, agent: "id-svc", owner: "testers", name: "opts" };
    expect(
      () => new AgentService({ ...base, minSenderTrust: "verified" as unknown as "any" }),
    ).toThrow(/minSenderTrust/);
    expect(() => new AgentService({ ...base, replayWindowMs: 0 })).toThrow(/replayWindowMs/);
    expect(() => new AgentService({ ...base, accountTokenPosition: 0 })).toThrow(
      /accountTokenPosition/,
    );
    expect(() => new AgentService({ ...base, accountTokenPosition: 2 })).not.toThrow();
    expect(() => new AgentService({ ...base, resolveTtlMs: -1 })).toThrow(/resolveTtlMs/);
    expect(() => new AgentService({ ...base, resolveTtlMs: Number.NaN })).toThrow(/resolveTtlMs/);
    expect(() => new AgentService({ ...base, resolveTtlMs: 0 })).not.toThrow();
    expect(
      () => new AgentService({ ...base, operatorAttested: "yes" as unknown as boolean }),
    ).toThrow(/operatorAttested/);
    const svc = new AgentService({ ...base, operatorAttested: true });
    expect(svc.operatorAttested).toBe(true);
    expect(new AgentService(base).operatorAttested).toBe(false);
  });

  it("response.sender.resolve() is bound: a verified sender resolves to the agent registered under its ID (here: this very service, alice on both ends)", async () => {
    const resolved: Array<AgentInfo | undefined> = [];
    const service = new AgentService({
      nc: hostNc,
      agent: "id-svc",
      owner: "testers",
      name: "resolving",
      heartbeatIntervalS: 1,
      keepaliveIntervalS: null,
      identity: { signer: aliceSigner },
    });
    service.onPrompt(async (_env, response) => {
      const s = response.sender;
      resolved.push(s?.trust === "verified" ? await s.resolve() : undefined);
      await response.send("ok");
    });
    await service.start();
    perTest.push(() => service.stop());
    await drain(await (await discover(client({ signer: aliceSigner }), service)).prompt("hi"));
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.identity).toBe(ALICE_ID);
    expect(resolved[0]?.idSigVerified).toBe(true);
    expect(resolved[0]?.instanceId).toBe(service.instanceId);
  });
});

describe.skipIf(!bin)(
  "AgentService — operator-attested mode and resolve() across accounts (accounts.conf)",
  () => {
    const server = new NatsServerProcess();
    const conns = new Map<string, NatsConnection>();
    const perTest: Array<() => Promise<void>> = [];
    const seen: Array<{ sender: SenderInfo | undefined; resolved: AgentInfo | undefined }> = [];
    let host: AgentService;
    let aliceSvc: AgentService;
    let hostLines: LogLine[];

    function user(name: string): { public: string; seed: string } {
      const u = keys.users[name];
      if (!u) throw new Error(`no fixture user ${name}`);
      return u;
    }

    beforeAll(async () => {
      await server.start({ configPath: identityFixture("accounts.conf") });
      for (const name of ["alice", "bob", "carol"]) {
        conns.set(name, await connectAs(server.url, user(name).seed));
      }
      const { logger, lines } = capturingLogger();
      hostLines = lines;
      // carol (ACME) hosts with operatorAttested: the deployment "closed" the
      // endpoint; for the test, ACME's own users play the forgers.
      host = new AgentService({
        nc: conns.get("carol")!,
        agent: "acme-svc",
        owner: "acme",
        name: "attested",
        heartbeatIntervalS: 1,
        keepaliveIntervalS: null,
        identity: { signer: signerFromSeed(user("carol").seed) },
        operatorAttested: true,
        logger,
      });
      host.onPrompt(async (_env, response) => {
        const s = response.sender;
        seen.push({ sender: s, resolved: s?.trust === "verified" ? await s.resolve() : undefined });
        await response.send(formatSender(s));
      });
      await host.start();
      // alice (ACME) registers her own service with a signer → her ID resolves.
      aliceSvc = new AgentService({
        nc: conns.get("alice")!,
        agent: "alice-svc",
        owner: "acme",
        name: "own",
        heartbeatIntervalS: 1,
        keepaliveIntervalS: null,
        identity: { signer: signerFromSeed(user("alice").seed) },
      });
      aliceSvc.onPrompt(async (_e, r) => {
        await r.send("mine");
      });
      await aliceSvc.start();
    });

    afterEach(async () => {
      for (const c of perTest.splice(0).reverse()) await c();
    });

    afterAll(async () => {
      await aliceSvc.stop();
      await host.stop();
      for (const nc of conns.values()) await nc.close();
      await server.stop();
    });

    function agentsFor(name: string): Agents {
      const agents = new Agents({
        nc: conns.get(name)!,
        identity: { signer: signerFromSeed(user(name).seed), name },
      });
      perTest.push(() => agents.close());
      return agents;
    }

    async function discoverHost(agents: Agents) {
      const [agent] = await agents.discover({ timeoutMs: 800, filter: { agent: "acme-svc" } });
      if (!agent) throw new Error("acme-svc not discovered");
      return agent;
    }

    const echoOf = (events: StreamMessage[]): string =>
      (events.find((e) => e.type === "response") as { text: string }).text;

    it("bob (APP, share: true): the server stamp agrees → accountAttested, echo `(verified)`; resolve() → undefined (APP's registrations are invisible from ACME)", async () => {
      const bob = agentsFor("bob");
      const events = await drain(await (await discoverHost(bob)).prompt("hi"));
      const bobId = newAgentId("APP", user("bob").public);
      expect(echoOf(events)).toBe(`${bobId} (verified)`);
      expect(seen.at(-1)?.sender).toMatchObject({
        trust: "verified",
        id: bobId,
        accountAttested: true,
      });
      expect(seen.at(-1)?.resolved).toBeUndefined();
    });

    it("alice (ACME, no stamp): verified, account not attested; resolve() → alice's own AgentService registration", async () => {
      const alice = agentsFor("alice");
      const events = await drain(await (await discoverHost(alice)).prompt("hi"));
      const aliceId = newAgentId("ACME", user("alice").public);
      expect(echoOf(events)).toBe(`${aliceId} (verified user, claimed account)`);
      expect(seen.at(-1)?.sender).toMatchObject({
        trust: "verified",
        id: aliceId,
        accountAttested: false,
      });
      expect(seen.at(-1)?.resolved?.identity).toBe(aliceId);
      expect(seen.at(-1)?.resolved?.idSigVerified).toBe(true);
      expect(seen.at(-1)?.resolved?.instanceId).toBe(aliceSvc.instanceId);
      expect(seen.at(-1)?.resolved?.promptEndpoint.subject).toBe(aliceSvc.subject.prompt);
    });

    it("a forged Nats-Request-Info from a same-account user → 401 `sender rejected`, logged with the disagreeing field, before the ack", async () => {
      const h = await signSenderHeader({
        signer: signerFromSeed(user("alice").seed),
        id: newAgentId("ACME", user("alice").public),
        sub: host.subject.prompt,
        payload: PAYLOAD,
      });
      const hdrs = withHeader(serializeSenderHeader(h));
      hdrs.set(NATS_REQUEST_INFO_HEADER, JSON.stringify({ acc: "APP", user: user("bob").public }));
      const before = seen.length;
      const msgs = await rawPrompt(conns.get("alice")!, host.subject.prompt, PAYLOAD, hdrs);
      expect(msgs).toHaveLength(1); // the error frame — no ack preceded it
      expect(errorCode(msgs)).toBe("401");
      expect(msgs[0]?.headers?.get("Nats-Service-Error")).toBe("sender rejected");
      expect(seen).toHaveLength(before);
      expect(
        hostLines.some(
          (l) =>
            l.level === "warn" &&
            /Nats-Request-Info acc "APP" disagrees/.test(String(l.ctx?.["reason"])),
        ),
      ).toBe(true);
    });
  },
);

describe.skipIf(!bin)("AgentService — sender identity on a no-auth server (T0)", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;

  beforeAll(async () => {
    await server.start();
    nc = await connect({ servers: server.url });
  });

  afterAll(async () => {
    await nc.close();
    await server.stop();
  });

  it("omitted host identity performs no self lookup or warning, still advertises min_sender_trust, and serves header-less requests", async () => {
    const { logger, lines } = capturingLogger();
    const service = new AgentService({
      nc,
      agent: "t0",
      owner: "testers",
      name: "x",
      heartbeatIntervalS: 1,
      keepaliveIntervalS: null,
      logger,
    });
    let sender: unknown = "unset";
    service.onPrompt(async (_e, r) => {
      sender = r.sender;
      await r.send("ok");
    });
    await service.start();
    try {
      expect(service.identity).toBeUndefined();
      expect(lines.some((l) => /without identity metadata/.test(l.msg))).toBe(false);
      const agents = new Agents({ nc });
      const [agent] = await agents.discover({ timeoutMs: 800, filter: { agent: "t0" } });
      expect(agent?.supportsSenderIdentity).toBe(true);
      expect(agent?.metadata[IDENTITY_METADATA_KEYS.userNkey]).toBeUndefined();
      await drain(await agent!.prompt("hi"));
      expect(sender).toBeUndefined();
      await agents.close();
    } finally {
      await service.stop();
    }
  });
});

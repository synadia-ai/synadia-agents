// Host-side identity rows (plan §6.4 T0 / T1) through `AgentService`:
// registration metadata, classification before the ack, `min_sender_trust`,
// the acceptance hook, `status` classify-only, the `PromptResponse.sender`
// shape the harness sees, and a cross-account (T3) row.

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
  newAgentId,
  serializeSenderHeader,
  type ServiceError,
  signerFromSeed,
  signSenderHeader,
  verifyAgentId,
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

    await drain(await (await discover(client(), service)).prompt("hi"));
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
    const e401 = await drain(await (await discover(client(), refusing.service)).prompt("hi")).then(
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

    const throwing = await startService({
      acceptSender: () => Promise.reject(new Error("registry down")),
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

  it("option validation: minSenderTrust, replayWindowMs, accountTokenPosition", () => {
    const base = { nc: hostNc, agent: "id-svc", owner: "testers", name: "opts" };
    expect(
      () => new AgentService({ ...base, minSenderTrust: "verified" as unknown as "any" }),
    ).toThrow(/minSenderTrust/);
    expect(() => new AgentService({ ...base, replayWindowMs: 0 })).toThrow(/replayWindowMs/);
    expect(() => new AgentService({ ...base, accountTokenPosition: 0 })).toThrow(
      /accountTokenPosition/,
    );
    expect(() => new AgentService({ ...base, accountTokenPosition: 2 })).not.toThrow();
  });
});

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

  it("starts without identity metadata (logged), still advertises min_sender_trust, serves header-less requests", async () => {
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
      expect(lines.some((l) => l.level === "warn" && /without identity metadata/.test(l.msg))).toBe(
        true,
      );
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

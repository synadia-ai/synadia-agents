// Identity T1 — one nkey user on a config-file server without accounts
// (`nkey-noaccounts.conf`, global account `$G`): the full caller ↔ host
// matrix of plan §6.4 T1 over a real broker.

import { readFile } from "node:fs/promises";
import {
  Empty,
  headers,
  nkeyAuthenticator,
  type Msg,
  type MsgHdrs,
  type NatsConnection,
} from "@nats-io/nats-core";
import { Svcm } from "@nats-io/services";
import { connect } from "@nats-io/transport-node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentService } from "@synadia-ai/agent-service";
import { ReferenceAgent, type ReferenceAgentOptions } from "@synadia-ai/agent-service/testing";
import {
  AGENT_SENDER_HEADER,
  Agents,
  buildClaimHeader,
  encodedHeaderLength,
  formatSenderTimestamp,
  IDENTITY_METADATA_KEYS,
  IdentityError,
  IdentityMismatchError,
  maxSenderHeaderBytes,
  MIN_SENDER_TRUST_KEY,
  newAgentId,
  PayloadTooLargeError,
  serializeSenderHeader,
  SERVICE_NAME,
  ServiceError,
  signerFromSeed,
  signSenderHeader,
  type AgentSenderHeader,
  type Logger,
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
const ALICE = keys.users["alice"]!;
const BOB = keys.users["bob"]!;
const aliceSigner = signerFromSeed(ALICE.seed);
const bobSigner = signerFromSeed(BOB.seed);
const ALICE_ID = newAgentId("$G", ALICE.public);
const BOB_ID = newAgentId("$G", BOB.public);
const PAYLOAD = enc.encode('{"prompt":"hi"}');

interface Seen {
  readonly sender: SenderInfo | undefined;
  readonly header: string | undefined;
  readonly payload: Uint8Array;
}

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

function connectAlice(url: string): Promise<NatsConnection> {
  return connect({
    servers: url,
    authenticator: nkeyAuthenticator(enc.encode(ALICE.seed)),
    reconnect: false,
  });
}

function withHeader(value: string | string[] | MsgHdrs, name = AGENT_SENDER_HEADER): MsgHdrs {
  if (typeof value !== "string" && !Array.isArray(value)) return value;
  const h = headers();
  for (const v of Array.isArray(value) ? value : [value]) h.append(name, v);
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

function errorCode(msgs: Msg[]): string | undefined {
  return msgs[0]?.headers?.get("Nats-Service-Error-Code") || undefined;
}

function patched(h: AgentSenderHeader, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(serializeSenderHeader(h)) as object), ...patch });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!bin)("identity T1 — nkey user, no accounts ($G)", () => {
  const server = new NatsServerProcess();
  let callerNc: NatsConnection;
  let hostNc: NatsConnection;
  const cleanups: Array<() => Promise<void>> = [];
  const perTest: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf") });
    callerNc = await connectAlice(server.url);
    hostNc = await connectAlice(server.url);
  });

  afterEach(async () => {
    for (const c of perTest.splice(0).reverse()) await c();
  });

  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await callerNc.close();
    await hostNc.close();
    await server.stop();
  });

  interface Started {
    readonly ref: ReferenceAgent;
    readonly seen: Seen[];
    readonly lines: LogLine[];
  }

  async function startRef(overrides: Partial<ReferenceAgentOptions> = {}): Promise<Started> {
    const seen: Seen[] = [];
    const { logger, lines } = capturingLogger();
    const ref = new ReferenceAgent({
      nc: hostNc,
      agent: "t1-ref",
      owner: "testers",
      name: `ref-${Math.random().toString(36).slice(2, 8)}`,
      identity: { signer: aliceSigner },
      logger,
      promptHandler: (msg, sender) => {
        seen.push({ sender, header: msg.headers?.get(AGENT_SENDER_HEADER), payload: msg.data });
        msg.respond(enc.encode(JSON.stringify({ type: "response", data: "ok" })));
        msg.respond(Empty);
      },
      ...overrides,
    });
    await ref.start();
    perTest.push(() => ref.stop());
    return { ref, seen, lines };
  }

  function client(identity?: ConstructorParameters<typeof Agents>[0]["identity"]): Agents {
    const agents = new Agents({ nc: callerNc, ...(identity ? { identity } : {}) });
    perTest.push(() => agents.close());
    return agents;
  }

  async function discover(agents: Agents, ref: ReferenceAgent) {
    const [agent] = await agents.discover({
      timeoutMs: 800,
      filter: { agent: "t1-ref", name: ref.promptSubject.split(".").pop()! },
    });
    if (!agent) throw new Error("agent not discovered");
    return agent;
  }

  async function drain(stream: AsyncIterable<StreamMessage>): Promise<StreamMessage[]> {
    const out: StreamMessage[] = [];
    for await (const m of stream) out.push(m);
    return out;
  }

  it("selfId is $G.<user>; refreshSelfId agrees", async () => {
    const agents = client();
    expect(await agents.selfId()).toBe(ALICE_ID);
    expect(await agents.refreshSelfId()).toBe(ALICE_ID);
  });

  it("a signer that is not the connection's user → IdentityMismatchError at start() / selfId() / first prompt", async () => {
    // Dedicated connections: the mismatch is negative-cached per connection.
    const nc1 = await connectAlice(server.url);
    const nc2 = await connectAlice(server.url);
    perTest.push(() => nc1.close());
    perTest.push(() => nc2.close());

    const svc = new AgentService({
      nc: nc1,
      agent: "t1-svc",
      owner: "testers",
      name: "mismatch",
      identity: { signer: bobSigner },
    });
    svc.onPrompt(async () => {});
    await expect(svc.start()).rejects.toBeInstanceOf(IdentityMismatchError);

    const { ref } = await startRef();
    const agents = new Agents({ nc: nc2, identity: { signer: bobSigner } });
    perTest.push(() => agents.close());
    await expect(agents.selfId()).rejects.toBeInstanceOf(IdentityMismatchError);
    const agent = await discover(agents, ref);
    await expect(agent.prompt("hi")).rejects.toBeInstanceOf(IdentityMismatchError);
  });

  it("signed prompts verify (correct pair, accountAttested=false, name); consecutive prompts use fresh nonces", async () => {
    const { ref, seen } = await startRef();
    const agents = client({ signer: aliceSigner, name: "claude-code" });
    const agent = await discover(agents, ref);
    for (let i = 0; i < 2; i++) {
      const events = await drain(await agent.prompt(`hi ${i}`));
      expect(events.at(-1)).toEqual({ type: "status", status: "done" });
    }
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.sender?.trust).toBe("verified");
      if (s.sender?.trust !== "verified") throw new Error("unreachable");
      expect(s.sender.id).toBe(ALICE_ID);
      expect(s.sender.accountAttested).toBe(false);
      expect(s.sender.name).toBe("claude-code");
      expect(s.sender.header.sub).toBe(ref.promptSubject);
    }
    expect(seen[0]!.sender!.header.nonce).not.toBe(seen[1]!.sender!.header.nonce);
  });

  it("Agent.status() carries a header the host classifies as verified; a bad status header is logged and still answered; its nonce lands in the shared set", async () => {
    const { ref, lines } = await startRef();
    const agents = client({ signer: aliceSigner });
    const agent = await discover(agents, ref);
    const hb = await agent.status();
    expect(hb.instanceId).toBe(ref.instanceId);
    await sleep(50);
    const status = lines.filter((l) => l.msg === "status request");
    expect(status.at(-1)?.ctx?.["sender"]).toBe(`${ALICE_ID} (verified user, claimed account)`);

    // A signed status header, replayed: answered twice, the second logged as a replay.
    const h = await signSenderHeader({
      signer: aliceSigner,
      id: ALICE_ID,
      sub: ref.statusSubject,
      payload: Empty,
    });
    const hdrs = withHeader(serializeSenderHeader(h));
    for (let i = 0; i < 2; i++) {
      const reply = await callerNc.request(ref.statusSubject, Empty, {
        timeout: 2_000,
        headers: hdrs,
      });
      expect(reply.headers?.get("Nats-Service-Error-Code") || undefined).toBeUndefined();
      expect((JSON.parse(reply.string()) as { instance_id: string }).instance_id).toBe(
        ref.instanceId,
      );
    }
    await sleep(50);
    // The replay is caught by the nonce lookup inside classification.
    expect(
      lines.some(
        (l) =>
          l.level === "warn" &&
          /status request/.test(l.msg) &&
          /already seen|replayed/.test(
            typeof l.ctx?.["reason"] === "string" ? l.ctx["reason"] : "",
          ),
      ),
    ).toBe(true);

    // Malformed header on status: answered, logged.
    const reply = await callerNc.request(ref.statusSubject, Empty, {
      timeout: 2_000,
      headers: withHeader("{not json"),
    });
    expect(reply.headers?.get("Nats-Service-Error-Code") || undefined).toBeUndefined();
    await sleep(50);
    expect(lines.some((l) => l.level === "warn" && l.ctx?.["code"] === 400)).toBe(true);
  });

  it("replay of a captured header → 401; the same nonce from another user is accepted", async () => {
    const { ref, seen } = await startRef();
    const agents = client({ signer: aliceSigner });
    const agent = await discover(agents, ref);
    await drain(await agent.prompt("hi"));
    const first = seen[0]!;
    expect(first.sender?.trust).toBe("verified");

    const replay = await rawPrompt(
      callerNc,
      ref.promptSubject,
      first.payload,
      withHeader(first.header!),
    );
    expect(errorCode(replay)).toBe("401");
    expect(replay[0]?.headers?.get("Nats-Service-Error")).toBe("sender rejected");
    expect(replay.at(-1)?.data.length).toBe(0); // terminator follows the error frame

    const nonce = first.sender!.header.nonce!;
    const other = await signSenderHeader({
      signer: bobSigner,
      id: BOB_ID,
      sub: ref.promptSubject,
      payload: first.payload,
      nonce,
    });
    const msgs = await rawPrompt(
      callerNc,
      ref.promptSubject,
      first.payload,
      withHeader(serializeSenderHeader(other)),
    );
    expect(errorCode(msgs)).toBeUndefined();
    expect(seen.at(-1)?.sender).toMatchObject({ trust: "verified", id: BOB_ID });
  });

  it("stale ts → 401 and the nonce is NOT recorded (a fresh header with the same nonce verifies)", async () => {
    const { ref, seen } = await startRef();
    const nonce = "stale-then-fresh";
    const stale = await signSenderHeader({
      signer: aliceSigner,
      id: ALICE_ID,
      sub: ref.promptSubject,
      payload: PAYLOAD,
      ts: formatSenderTimestamp(Date.now() - 120_000),
      nonce,
    });
    expect(
      errorCode(
        await rawPrompt(
          callerNc,
          ref.promptSubject,
          PAYLOAD,
          withHeader(serializeSenderHeader(stale)),
        ),
      ),
    ).toBe("401");
    const fresh = await signSenderHeader({
      signer: aliceSigner,
      id: ALICE_ID,
      sub: ref.promptSubject,
      payload: PAYLOAD,
      nonce,
    });
    expect(
      errorCode(
        await rawPrompt(
          callerNc,
          ref.promptSubject,
          PAYLOAD,
          withHeader(serializeSenderHeader(fresh)),
        ),
      ),
    ).toBeUndefined();
    expect(seen.at(-1)?.sender?.trust).toBe("verified");
  });

  it("nonce expiry is anchored on ts: a header with ts in the future still replays after arrival + window", async () => {
    const windowMs = 3_000;
    const { ref } = await startRef({ replayWindowMs: windowMs });
    const h = await signSenderHeader({
      signer: aliceSigner,
      id: ALICE_ID,
      sub: ref.promptSubject,
      payload: PAYLOAD,
      ts: formatSenderTimestamp(Date.now() + 2_000),
    });
    const hdrs = withHeader(serializeSenderHeader(h));
    expect(errorCode(await rawPrompt(callerNc, ref.promptSubject, PAYLOAD, hdrs))).toBeUndefined();
    await sleep(windowMs + 500);
    // ts is still inside the window (~1.5 s old); an arrival-anchored cache would have forgotten the nonce.
    expect(errorCode(await rawPrompt(callerNc, ref.promptSubject, PAYLOAD, hdrs))).toBe("401");
  }, 15_000);

  it("transplanted / rewritten / tampered headers → 401 in every mode (including `any`)", async () => {
    const { ref: a } = await startRef();
    const { ref: b } = await startRef();
    const h = await signSenderHeader({
      signer: aliceSigner,
      id: ALICE_ID,
      sub: a.promptSubject,
      payload: PAYLOAD,
    });
    const cases: Array<[string, string, string, Uint8Array]> = [
      ["verbatim on another subject", b.promptSubject, serializeSenderHeader(h), PAYLOAD],
      [
        "sub rewritten to the arrival subject",
        b.promptSubject,
        patched(h, { sub: b.promptSubject }),
        PAYLOAD,
      ],
      ["account rewritten", a.promptSubject, patched(h, { account: "ACME" }), PAYLOAD],
      ["user rewritten", a.promptSubject, patched(h, { user: BOB.public }), PAYLOAD],
      [
        "payload tampered",
        a.promptSubject,
        serializeSenderHeader(h),
        enc.encode('{"prompt":"ho"}'),
      ],
    ];
    for (const [label, subject, value, payload] of cases) {
      const msgs = await rawPrompt(callerNc, subject, payload, withHeader(value));
      expect(errorCode(msgs), label).toBe("401");
    }
    // The untouched header still verifies afterwards: nothing above poisoned the nonce set.
    expect(
      errorCode(
        await rawPrompt(callerNc, a.promptSubject, PAYLOAD, withHeader(serializeSenderHeader(h))),
      ),
    ).toBeUndefined();
  });

  it("malformed headers → 400", async () => {
    const { ref } = await startRef();
    const h = await signSenderHeader({
      signer: aliceSigner,
      id: ALICE_ID,
      sub: ref.promptSubject,
      payload: PAYLOAD,
      name: "n",
    });
    const noSub = JSON.parse(serializeSenderHeader(h)) as Record<string, unknown>;
    delete noSub["sub"];
    const cases: Array<[string, string | string[]]> = [
      ["sig without sub", JSON.stringify(noSub)],
      ['"v":"1"', patched(h, { v: "1" })],
      ["v:true", patched(h, { v: true })],
      ["55-char user", patched(h, { user: ALICE.public.slice(0, 55) })],
      ["ts yesterday", patched(h, { ts: "yesterday" })],
      ["bad nonce", patched(h, { nonce: "a.b" })],
      ["name with control char", patched(h, { name: "a\tb" })],
      ["> 2 KiB", patched(h, { pad: "x".repeat(2100) })],
      ["not json", "{"],
      ["two values", [serializeSenderHeader(h), serializeSenderHeader(h)]],
    ];
    for (const [label, value] of cases) {
      const msgs = await rawPrompt(callerNc, ref.promptSubject, PAYLOAD, withHeader(value));
      expect(errorCode(msgs), label).toBe("400");
      expect(msgs.at(-1)?.data.length, label).toBe(0);
    }
  });

  it("unknown v → absent (served on `any` with no sender, 401 on `signed`); lowercase header name → absent", async () => {
    const { ref: anyRef, seen } = await startRef();
    const { ref: signedRef } = await startRef({ minSenderTrust: "signed" });
    const h = await signSenderHeader({
      signer: aliceSigner,
      id: ALICE_ID,
      sub: anyRef.promptSubject,
      payload: PAYLOAD,
    });
    expect(
      errorCode(
        await rawPrompt(callerNc, anyRef.promptSubject, PAYLOAD, withHeader(patched(h, { v: 2 }))),
      ),
    ).toBeUndefined();
    expect(seen.at(-1)?.sender).toBeUndefined();
    expect(
      errorCode(
        await rawPrompt(
          callerNc,
          signedRef.promptSubject,
          PAYLOAD,
          withHeader(patched(h, { v: 2 })),
        ),
      ),
    ).toBe("401");
    expect(
      errorCode(
        await rawPrompt(
          callerNc,
          anyRef.promptSubject,
          PAYLOAD,
          withHeader(serializeSenderHeader(h), "agent-sender"),
        ),
      ),
    ).toBeUndefined();
    expect(seen.at(-1)?.sender).toBeUndefined();
  });

  it("no signer → an unsigned claim (ClaimedSender, no id) by default; sendUnsignedClaim=false → no header; `signed` endpoint rejects a claim with 401", async () => {
    const { ref, seen } = await startRef();
    const agents = client({ name: "claimant" });
    const agent = await discover(agents, ref);
    await drain(await agent.prompt("hi"));
    const claim = seen.at(-1)?.sender;
    expect(claim?.trust).toBe("claimed");
    expect(claim && "id" in claim).toBe(false);
    if (claim?.trust !== "claimed") throw new Error("unreachable");
    expect(claim.claim).toEqual({ account: "$G", user: ALICE.public });
    expect(claim.name).toBe("claimant");

    const silent = client({ sendUnsignedClaim: false });
    await drain(await (await discover(silent, ref)).prompt("hi"));
    expect(seen.at(-1)?.header).toBeFalsy();
    expect(seen.at(-1)?.sender).toBeUndefined();

    const { ref: signedRef } = await startRef({ minSenderTrust: "signed" });
    const value = serializeSenderHeader(buildClaimHeader({ id: ALICE_ID }));
    const msgs = await rawPrompt(callerNc, signedRef.promptSubject, PAYLOAD, withHeader(value));
    expect(errorCode(msgs)).toBe("401");
    expect(msgs[0]?.headers?.get("Nats-Service-Error")).toBe("signature required");
  });

  it("acceptSender: false → 403 (verified) / 401 (claimed, absent); throw → 500; true → served", async () => {
    const refuse = await startRef({ acceptSender: () => false });
    const signed = client({ signer: aliceSigner });
    const claimer = client();
    const err = await drain(await (await discover(signed, refuse.ref)).prompt("hi")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(403);
    const errClaim = await drain(await (await discover(claimer, refuse.ref)).prompt("hi")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((errClaim as ServiceError).code).toBe(401);
    expect(errorCode(await rawPrompt(callerNc, refuse.ref.promptSubject, PAYLOAD))).toBe("401");

    const boom = await startRef({
      acceptSender: () => {
        throw new Error("db down");
      },
    });
    const err500 = await drain(await (await discover(signed, boom.ref)).prompt("hi")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err500 as ServiceError).code).toBe(500);
    expect(boom.seen).toHaveLength(0);
    expect(boom.lines.some((l) => l.level === "error")).toBe(true);

    const accepted: Array<SenderInfo | undefined> = [];
    const ok = await startRef({
      acceptSender: (s) => {
        accepted.push(s);
        return Promise.resolve(true);
      },
    });
    await drain(await (await discover(signed, ok.ref)).prompt("hi"));
    expect(ok.seen).toHaveLength(1);
    expect(accepted[0]?.trust).toBe("verified");
  });

  it("max_payload counts the framed header: at the limit → accepted, one byte more → PayloadTooLargeError before publish", async () => {
    const limit = 2048;
    const { ref, seen } = await startRef({ maxPayload: "2KB" });
    const name = "n".repeat(64);
    const agents = client({ signer: aliceSigner, name });
    const agent = await discover(agents, ref);
    const bound = maxSenderHeaderBytes(ref.promptSubject, name);
    const envelopeOverhead = '{"prompt":""}'.length;
    const fits = "x".repeat(limit - bound - envelopeOverhead);

    await drain(await agent.prompt(fits));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sender?.trust).toBe("verified");
    expect(encodedHeaderLength(seen[0]!.header!) + seen[0]!.payload.length).toBeLessThanOrEqual(
      limit,
    );

    let caught: unknown;
    try {
      agent.prompt(fits + "x"); // synchronous throw (the bound)
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PayloadTooLargeError);
    expect((caught as PayloadTooLargeError).headerBytes).toBe(bound);
    expect(seen).toHaveLength(1);
  });

  it("identity.name is validated when the option is set", () => {
    expect(() => new Agents({ nc: callerNc, identity: { name: "x".repeat(65) } })).toThrow(
      IdentityError,
    );
    expect(() => new Agents({ nc: callerNc, identity: { name: "a\nb" } })).toThrow(IdentityError);
    expect(() => new Agents({ nc: callerNc, identity: { name: "x".repeat(64) } })).not.toThrow();
  });

  it("$SRV.INFO carries user_nkey / account / id_sig; AgentInfo.identity === selfId; idSigVerified; a tampered id_sig fails", async () => {
    const { ref } = await startRef();
    const agents = client({ signer: aliceSigner });
    const agent = await discover(agents, ref);
    expect(agent.metadata[IDENTITY_METADATA_KEYS.userNkey]).toBe(ALICE.public);
    expect(agent.metadata[IDENTITY_METADATA_KEYS.account]).toBe("$G");
    expect(agent.metadata[IDENTITY_METADATA_KEYS.idSig]).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(agent.promptEndpoint.metadata[MIN_SENDER_TRUST_KEY]).toBe("any");
    expect(agent.identity).toBe(await agents.selfId());
    expect(agent.idSigVerified).toBe(true);
    expect(ref.identity).toBe(ALICE_ID);

    const tampered = agent.metadata[IDENTITY_METADATA_KEYS.idSig]!.slice(0, -2) + "AA";
    const svc = await new Svcm(hostNc).add({
      name: SERVICE_NAME,
      version: "0.0.1",
      metadata: { ...agent.metadata, [IDENTITY_METADATA_KEYS.idSig]: tampered },
    });
    svc.addEndpoint("prompt", {
      subject: ref.promptSubject.replace(/\.[^.]+$/, ".tampered"),
      queue: "agents",
      handler: (_e, m) => {
        m.respond(Empty);
      },
      metadata: { max_payload: "1MB", attachments_ok: "true", min_sender_trust: "any" },
    });
    perTest.push(() => svc.stop().then(() => undefined));
    await hostNc.flush(); // the hand-registered SUBs must be at the server before discovery
    const [bad] = await agents.discover({
      timeoutMs: 800,
      filter: { agent: "t1-ref", name: "tampered" },
    });
    expect(bad?.identity).toBe(ALICE_ID);
    expect(bad?.idSigVerified).toBe(false);
  });

  it("host without a signer registers user_nkey/account but no id_sig", async () => {
    const svc = new AgentService({
      nc: hostNc,
      agent: "t1-svc",
      owner: "testers",
      name: "nosigner",
      heartbeatIntervalS: 1,
    });
    svc.onPrompt(async (_e, r) => {
      await r.send("ok");
    });
    await svc.start();
    perTest.push(() => svc.stop());
    const agents = client();
    const [agent] = await agents.discover({
      timeoutMs: 800,
      filter: { agent: "t1-svc", name: "nosigner" },
    });
    expect(agent?.metadata[IDENTITY_METADATA_KEYS.userNkey]).toBe(ALICE.public);
    expect(agent?.metadata[IDENTITY_METADATA_KEYS.idSig]).toBeUndefined();
    expect(agent?.identity).toBe(ALICE_ID);
    expect(agent?.idSigVerified).toBe(false);
  });
});

// Identity T2 / T3 / T4 on `accounts.conf` (config-file accounts ACME,
// APP, APP2, APP3) plus the `account_token_position` variant on
// `account-token-position.conf` — cross-account signing needs nothing from
// either side but the caller's own import configuration (plan §2.3b).

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
  formatSender,
  newAgentId,
  parseSenderHeader,
  readSenderHeaderValue,
  SenderVerificationError,
  serializeSenderHeader,
  ServiceError,
  signerFromSeed,
  signSenderHeader,
  verifySenderHeader,
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
  const seen: Array<{ sender: SenderInfo | undefined; requestInfo: string | undefined }> = [];
  let ref: ReferenceAgent;
  let sibling: ReferenceAgent;
  const perTest: Array<() => Promise<void>> = [];

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
  });

  afterEach(async () => {
    for (const c of perTest.splice(0).reverse()) await c();
  });

  afterAll(async () => {
    await ref.stop();
    await sibling.stop();
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

  async function discoverMain(agents: Agents) {
    const [agent] = await agents.discover({
      timeoutMs: 800,
      filter: { agent: "acme-agent", name: "main" },
    });
    if (!agent) throw new Error("acme-agent/main not discovered");
    return agent;
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

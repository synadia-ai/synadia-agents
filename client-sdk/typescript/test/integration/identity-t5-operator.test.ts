// Identity T5 — operator mode, local (`test-fixtures/identity/operator/`):
// 113-char agent IDs whose `account` is the account public NKEY, the
// live `$SYS.REQ.USER.INFO` binding agreeing with the credentials JWT,
// registration in that form, and the NGS shape of
// operator-attested mode — a `share: true` import stamps `Nats-Request-Info`
// with the 56-char `acc`, which the cross-check attests.

import { readFile } from "node:fs/promises";
import {
  credsAuthenticator,
  Empty,
  headers,
  type Msg,
  type NatsConnection,
} from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ReferenceAgent } from "@synadia-ai/agent-service/testing";
import {
  AGENT_SENDER_HEADER,
  agentIdAccount,
  agentIdUser,
  Agents,
  formatSender,
  identityFromJwt,
  lookupSelfId,
  NATS_REQUEST_INFO_HEADER,
  newAgentId,
  serializeSenderHeader,
  signerFromCredsFile,
  signSenderHeader,
  type SenderInfo,
  type SenderSigner,
  type StreamMessage,
} from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";

interface OperatorKeys {
  readonly accounts: Record<string, { readonly public: string }>;
  readonly users: Record<string, { readonly public: string; readonly account: string }>;
}

const bin = await findNatsServerBinary();
const keys = JSON.parse(
  await readFile(identityFixture("operator/keys.json"), "utf8"),
) as OperatorKeys;
const enc = new TextEncoder();
const PAYLOAD = enc.encode('{"prompt":"hi"}');
const ACCOUNT_KEY = /^A[A-Z2-7]{55}$/;
const OPERATOR_FORM_LENGTH = 113;

const credsPath = (name: string): string => identityFixture(`operator/${name}.creds`);

async function connectWithCreds(url: string, name: string): Promise<NatsConnection> {
  return connect({
    servers: url,
    authenticator: credsAuthenticator(enc.encode(await readFile(credsPath(name), "utf8"))),
    reconnect: false,
  });
}

function expectedId(name: string): ReturnType<typeof newAgentId> {
  const u = keys.users[name]!;
  return newAgentId(keys.accounts[u.account]!.public, u.public);
}

async function drain(stream: AsyncIterable<StreamMessage>): Promise<StreamMessage[]> {
  const out: StreamMessage[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

describe.skipIf(!bin)("identity T5 — operator mode (operator/operator.conf)", () => {
  const server = new NatsServerProcess();
  const conns = new Map<string, NatsConnection>();
  const signers = new Map<string, SenderSigner>();
  const seen: Array<{ sender: SenderInfo | undefined; requestInfo: string | undefined }> = [];
  const perTest: Array<() => Promise<void>> = [];
  let ref: ReferenceAgent;

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("operator/operator.conf") });
    for (const name of ["alice", "carol", "bob"]) {
      conns.set(name, await connectWithCreds(server.url, name));
      signers.set(name, await signerFromCredsFile(credsPath(name)));
    }
    ref = new ReferenceAgent({
      nc: conns.get("alice")!,
      agent: "op-agent",
      owner: "acme",
      name: "main",
      identity: { signer: signers.get("alice")! },
      operatorAttested: true,
      promptHandler: (msg: Msg, sender) => {
        seen.push({ sender, requestInfo: msg.headers?.get(NATS_REQUEST_INFO_HEADER) || undefined });
        msg.respond(enc.encode(JSON.stringify({ type: "response", data: formatSender(sender) })));
        msg.respond(Empty);
      },
    });
    await ref.start();
  });

  afterEach(async () => {
    for (const c of perTest.splice(0).reverse()) await c();
  });

  afterAll(async () => {
    await ref.stop();
    for (const nc of conns.values()) await nc.close();
    await server.stop();
  });

  function agentsFor(name: string): Agents {
    const agents = new Agents({
      nc: conns.get(name)!,
      identity: { signer: signers.get(name)!, name },
    });
    perTest.push(() => agents.close());
    return agents;
  }

  async function discoverMain(agents: Agents) {
    const [agent] = await agents.discover({ timeoutMs: 800, filter: { agent: "op-agent" } });
    if (!agent) throw new Error("op-agent/main not discovered");
    return agent;
  }

  it("selfId is the 113-char A….U… form; the credentials JWT and $SYS.REQ.USER.INFO agree", async () => {
    const carol = agentsFor("carol");
    const id = await carol.selfId();
    expect(id).toBe(expectedId("carol"));
    expect(id).toHaveLength(OPERATOR_FORM_LENGTH);
    expect(agentIdAccount(id)).toMatch(ACCOUNT_KEY);
    expect(agentIdAccount(id)).toBe(keys.accounts["ACME"]!.public);
    expect(agentIdUser(id)).toBe(keys.users["carol"]!.public);
    // The JWT source (what the signer carries) and the server source agree.
    const signer = signers.get("carol")!;
    expect(signer.jwt).toBeDefined();
    expect(identityFromJwt(signer.jwt!)).toBe(id);
    expect(await lookupSelfId(conns.get("carol")!)).toBe(id);
  });

  it("registration carries the operator-mode pair and a verifying id_sig", async () => {
    const agent = await discoverMain(agentsFor("carol"));
    expect(agent.identity).toBe(expectedId("alice"));
    expect(agent.metadata["account"]).toBe(keys.accounts["ACME"]!.public);
    expect(agent.idSigVerified).toBe(true);
    expect(ref.identity).toBe(expectedId("alice"));
  });

  it("same account: a signed prompt verifies; no stamp → the account stays the sender's word even under operatorAttested", async () => {
    const carol = agentsFor("carol");
    const events = await drain(await (await discoverMain(carol)).prompt("hi"));
    expect((events.find((e) => e.type === "response") as { text: string }).text).toBe(
      `${expectedId("carol")} (verified user, claimed account)`,
    );
    expect(seen.at(-1)?.requestInfo).toBeUndefined();
    expect(seen.at(-1)?.sender).toMatchObject({
      trust: "verified",
      id: expectedId("carol"),
      accountAttested: false,
    });
  });

  it("cross-account through a share: true import (bob, APP): the stamp's acc is the 56-char account key, agrees with the signed account → accountAttested, `(verified)`", async () => {
    const bob = agentsFor("bob");
    expect(await bob.selfId()).toBe(expectedId("bob"));
    const agent = await discoverMain(bob); // through the exported $SRV.>
    const events = await drain(await agent.prompt("hi"));
    expect((events.find((e) => e.type === "response") as { text: string }).text).toBe(
      `${expectedId("bob")} (verified)`,
    );
    const last = seen.at(-1)!;
    const stamp = JSON.parse(last.requestInfo!) as { acc: string; user?: string };
    expect(stamp.acc).toBe(keys.accounts["APP"]!.public);
    expect(stamp.acc).toMatch(ACCOUNT_KEY);
    expect(stamp.user).toBe(keys.users["bob"]!.public);
    expect(last.sender).toMatchObject({
      trust: "verified",
      id: expectedId("bob"),
      accountAttested: true,
    });
    expect(await agent.status()).toMatchObject({ agent: "op-agent", instanceId: ref.instanceId });
  });

  it("a same-account user forging the stamp is refused (401) — the closed-endpoint promise is the deployment's, not the SDK's", async () => {
    const h = await signSenderHeader({
      signer: signers.get("carol")!,
      id: expectedId("carol"),
      sub: ref.promptSubject,
      payload: PAYLOAD,
    });
    const hdrs = headers();
    hdrs.set(AGENT_SENDER_HEADER, serializeSenderHeader(h));
    hdrs.set(
      NATS_REQUEST_INFO_HEADER,
      JSON.stringify({ acc: keys.accounts["APP"]!.public, user: keys.users["bob"]!.public }),
    );
    const out: Msg[] = [];
    for await (const m of await conns.get("carol")!.requestMany(ref.promptSubject, PAYLOAD, {
      strategy: "sentinel",
      maxWait: 3_000,
      headers: hdrs,
    })) {
      out.push(m);
    }
    expect(out[0]?.headers?.get("Nats-Service-Error-Code")).toBe("401");
  });
});

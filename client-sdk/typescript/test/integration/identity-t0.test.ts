// Identity T0 — a server without authentication: no identity anywhere,
// and everything keeps working exactly as in 0.3 (plan §0, §6.4 T0).

import { readFile } from "node:fs/promises";
import { Empty, headers, type Msg, type NatsConnection } from "@nats-io/nats-core";
import { Svcm } from "@nats-io/services";
import { connect } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentService, type PromptResponse } from "@synadia-ai/agent-service";
import { ReferenceAgent } from "@synadia-ai/agent-service/testing";
import {
  AGENT_SENDER_HEADER,
  Agents,
  IDENTITY_METADATA_KEYS,
  MIN_SENDER_TRUST_KEY,
  NoIdentityError,
  SenderSignatureRequiredError,
  SERVICE_NAME,
  signerFromSeed,
  USER_INFO_SUBJECT,
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

async function rawPrompt(nc: NatsConnection, subject: string, payload: Uint8Array): Promise<Msg[]> {
  const out: Msg[] = [];
  const iter = await nc.requestMany(subject, payload, { strategy: "sentinel", maxWait: 3_000 });
  for await (const m of iter) out.push(m);
  return out;
}

describe.skipIf(!bin)("identity T0 — no auth", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  let hostNc: NatsConnection;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    await server.start();
    nc = await connect({ servers: server.url });
    hostNc = await connect({ servers: server.url });
  });

  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await nc.close();
    await hostNc.close();
    await server.stop();
  });

  function startService(
    overrides: Partial<ConstructorParameters<typeof AgentService>[0]> = {},
    onPrompt?: (response: PromptResponse) => Promise<void>,
  ): AgentService {
    const service = new AgentService({
      nc: hostNc,
      agent: "t0-agent",
      owner: "testers",
      name: `inst-${Math.random().toString(36).slice(2, 8)}`,
      heartbeatIntervalS: 1,
      keepaliveIntervalS: null,
      ...overrides,
    });
    service.onPrompt(async (_env, response) => {
      if (onPrompt) await onPrompt(response);
      else await response.send("ok");
    });
    cleanups.push(() => service.stop());
    return service;
  }

  it("selfId() rejects with NoIdentityError whose message names the fix", async () => {
    const agents = new Agents({ nc });
    cleanups.push(() => agents.close());
    const err: unknown = await agents.selfId().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NoIdentityError);
    expect((err as Error).message).toMatch(/configure an nkey user/);
    expect((err as Error).message).toMatch(/credentials file/);
  });

  it("host registers min_sender_trust=any but no identity keys; a 0.3 service reports supportsSenderIdentity=false", async () => {
    const service = startService();
    await service.start();
    expect(service.identity).toBeUndefined();

    // A hand-registered 0.3 agent: no min_sender_trust at all.
    const legacy = await new Svcm(hostNc).add({
      name: SERVICE_NAME,
      version: "0.0.1",
      metadata: { agent: "legacy", owner: "testers", protocol_version: "0.3" },
    });
    legacy.addEndpoint("prompt", {
      subject: "agents.prompt.legacy.testers.old",
      queue: "agents",
      handler: (_e, m) => {
        m.respond(Empty);
      },
      metadata: { max_payload: "1MB", attachments_ok: "true" },
    });
    cleanups.push(() => legacy.stop().then(() => undefined));

    const agents = new Agents({ nc });
    cleanups.push(() => agents.close());
    const found = await agents.discover({ timeoutMs: 800, filter: { owner: "testers" } });
    const modern = found.find((a) => a.name === service.subject.name)!;
    const old = found.find((a) => a.agent === "legacy")!;
    expect(modern.promptEndpoint.metadata[MIN_SENDER_TRUST_KEY]).toBe("any");
    expect(modern.minSenderTrust).toBe("any");
    expect(modern.supportsSenderIdentity).toBe(true);
    expect(modern.metadata[IDENTITY_METADATA_KEYS.userNkey]).toBeUndefined();
    expect(modern.metadata[IDENTITY_METADATA_KEYS.account]).toBeUndefined();
    expect(modern.metadata[IDENTITY_METADATA_KEYS.idSig]).toBeUndefined();
    expect(modern.identity).toBeUndefined();
    expect(modern.idSigVerified).toBe(false);
    expect(old.supportsSenderIdentity).toBe(false);
    expect(old.minSenderTrust).toBeUndefined();
  });

  it("prompt sends no header, the harness sees sender=undefined, and the lookup runs once per connection", async () => {
    const seen: Array<{ sender: unknown; header: string | undefined }> = [];
    const ref = new ReferenceAgent({
      nc: hostNc,
      agent: "t0-ref",
      owner: "testers",
      name: `ref-${Math.random().toString(36).slice(2, 8)}`,
      promptHandler: (msg, sender) => {
        seen.push({ sender, header: msg.headers?.get(AGENT_SENDER_HEADER) });
        msg.respond(enc.encode(JSON.stringify({ type: "response", data: "ok" })));
        msg.respond(Empty);
      },
    });
    await ref.start();
    cleanups.push(() => ref.stop());

    // A fresh connection: the memo is per connection, and an earlier test
    // already negative-cached this file's shared `nc`. Count
    // $SYS.REQ.USER.INFO requests from here on (same account; the reference
    // agent's own lookup already happened in start()).
    const fresh = await connect({ servers: server.url });
    cleanups.push(() => fresh.close());
    const probes: Msg[] = [];
    const sub = fresh.subscribe(USER_INFO_SUBJECT, {
      callback: (_err, m) => {
        probes.push(m);
      },
    });
    await fresh.flush();

    const agents = new Agents({ nc: fresh });
    cleanups.push(() => agents.close());
    const [agent] = await agents.discover({ timeoutMs: 800, filter: { agent: "t0-ref" } });
    for (let i = 0; i < 2; i++) {
      const events: StreamMessage[] = [];
      for await (const m of await agent!.prompt(`hi ${i}`)) events.push(m);
      expect(events.at(-1)).toEqual({ type: "status", status: "done" });
    }
    await fresh.flush();
    sub.unsubscribe();
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.sender === undefined && !s.header)).toBe(true);
    expect(probes).toHaveLength(1);
  });

  it("status still answers, and a service handler sees response.sender === undefined", async () => {
    let sender: unknown = "unset";
    const service = startService({}, async (response) => {
      sender = response.sender;
      await response.send("ok");
    });
    await service.start();
    const agents = new Agents({ nc });
    cleanups.push(() => agents.close());
    const [agent] = await agents.discover({
      timeoutMs: 800,
      filter: { agent: "t0-agent", name: service.subject.name },
    });
    for await (const _m of await agent!.prompt("hi")) {
      /* drain */
    }
    expect(sender).toBeUndefined();
    const hb = await agent!.status();
    expect(hb.agent).toBe("t0-agent");
    expect(hb.instanceId).toBe(service.instanceId);
  });

  it("min_sender_trust=signed: header-less request → 401 + terminator; no signer → SenderSignatureRequiredError (sync); signer → NoIdentityError (rejection)", async () => {
    const service = startService({ minSenderTrust: "signed" });
    await service.start();

    const msgs = await rawPrompt(hostNc, service.subject.prompt, enc.encode('{"prompt":"hi"}'));
    expect(msgs[0]?.headers?.get("Nats-Service-Error-Code")).toBe("401");
    expect(msgs[0]?.headers?.get("Nats-Service-Error")).toBe("signature required");

    const plain = new Agents({ nc });
    cleanups.push(() => plain.close());
    const [agent] = await plain.discover({
      timeoutMs: 800,
      filter: { agent: "t0-agent", name: service.subject.name },
    });
    expect(agent!.minSenderTrust).toBe("signed");
    expect(() => agent!.prompt("hi")).toThrow(SenderSignatureRequiredError);

    const signing = new Agents({
      nc,
      identity: { signer: signerFromSeed(keys.users["alice"]!.seed) },
    });
    cleanups.push(() => signing.close());
    const [withSigner] = await signing.discover({
      timeoutMs: 800,
      filter: { agent: "t0-agent", name: service.subject.name },
    });
    await expect(withSigner!.prompt("hi")).rejects.toBeInstanceOf(NoIdentityError);
  });

  it("a request with an Agent-Sender header on a no-auth server is still classified (claim → claimed)", async () => {
    let sender: unknown = "unset";
    const service = startService({}, async (response) => {
      sender = response.sender;
      await response.send("ok");
    });
    await service.start();
    const h = headers();
    h.set(
      AGENT_SENDER_HEADER,
      JSON.stringify({ v: 1, account: "$G", user: keys.users["alice"]!.public, name: "x" }),
    );
    const iter = await hostNc.requestMany(service.subject.prompt, enc.encode('{"prompt":"hi"}'), {
      strategy: "sentinel",
      maxWait: 3_000,
      headers: h,
    });
    for await (const _m of iter) {
      /* drain */
    }
    expect(sender).toMatchObject({ trust: "claimed", claim: { account: "$G" }, name: "x" });
  });
});

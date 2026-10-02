// Prompt and request interceptors, end to end: a generic lineage extension
// (`test/support/lineage.ts`) built on the public hooks alone does what an
// extension that tracks prompt lineage across agents needs — a signed
// record before each prompt, two envelope fields, the half-pair refusal, a
// root minted when absent, the scope bound around the handler and inherited
// by a client used inside it, and counts on the heartbeat.

import { readFile } from "node:fs/promises";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import { createInbox, type Msg, type NatsConnection } from "@nats-io/nats-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentService,
  RequestRejectedError,
  type RequestInterceptor,
  type RequestInterceptorContext,
} from "@synadia-ai/agent-service";
import {
  Agents,
  decodeHeartbeatPayload,
  IdentityError,
  NatsAgentError,
  parseSenderHeader,
  PayloadTooLargeError,
  readSenderHeaderValue,
  ServiceError,
  signerFromSeed,
  verifySender,
  type Agent,
  type Logger,
  type PromptExtras,
  type PromptInterceptor,
  type PromptInterceptorContext,
  type RequestEnvelope,
} from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";
import {
  lineage,
  NODE_FIELD,
  NODE_HEADER,
  ROOT_FIELD,
  type Lineage,
  type LineageRecord,
  type LineageScope,
} from "../support/lineage.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}
const bin = await findNatsServerBinary();
const keys = JSON.parse(await readFile(identityFixture("keys.json"), "utf8")) as KeysFile;
const ALICE = keys.users["alice"]!;
const enc = new TextEncoder();
const dec = new TextDecoder();
const RECORDS = "lineage.records";

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _m of stream) {
    /* drain */
  }
}

/** Collect every message on `subject` into the returned array. */
function capture(nc: NatsConnection, subject: string): { msgs: Msg[]; stop: () => void } {
  const msgs: Msg[] = [];
  const sub = nc.subscribe(subject);
  void (async () => {
    for await (const m of sub) msgs.push(m);
  })();
  return { msgs, stop: () => sub.unsubscribe() };
}

async function until(cond: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Everything a raw request draws, up to and including the §6.5 terminator. */
async function rawStream(nc: NatsConnection, subject: string, body: string): Promise<Msg[]> {
  const msgs: Msg[] = [];
  const inbox = createInbox();
  const sub = nc.subscribe(inbox, { timeout: 5_000 });
  nc.publish(subject, body, { reply: inbox });
  for await (const m of sub) {
    msgs.push(m);
    if (m.data.length === 0 && !m.headers) break;
  }
  sub.unsubscribe();
  return msgs;
}

describe.skipIf(!bin)("prompt and request interceptors", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  let observer: NatsConnection;
  const signer = signerFromSeed(ALICE.seed);

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf") });
    const opts = {
      servers: server.url,
      authenticator: nkeyAuthenticator(enc.encode(ALICE.seed)),
      reconnect: false,
    };
    nc = await connect(opts);
    observer = await connect(opts);
  });
  afterAll(async () => {
    await observer.close();
    await nc.close();
    await server.stop();
  });

  interface Handled {
    readonly scope: LineageScope | undefined;
    readonly envelope: RequestEnvelope;
  }

  /** A started service running `lin.host` (plus `extra`) that records what its handler saw. */
  async function host(
    lin: Lineage,
    name: string,
    opts: {
      readonly extra?: ReadonlyArray<RequestInterceptor>;
      readonly onPrompt?: (handled: Handled) => Promise<void>;
      readonly maxPayload?: string;
    } = {},
  ): Promise<{ svc: AgentService; handled: Handled[] }> {
    const handled: Handled[] = [];
    const svc = new AgentService({
      nc,
      agent: "lineage",
      owner: "o",
      name,
      keepaliveIntervalS: null,
      ...(opts.maxPayload !== undefined ? { maxPayload: opts.maxPayload } : {}),
      interceptors: [lin.host, ...(opts.extra ?? [])],
      heartbeatExtras: lin.heartbeatExtras,
    });
    svc.onPrompt(async (envelope, response) => {
      const entry = { scope: lin.current(), envelope };
      handled.push(entry);
      await opts.onPrompt?.(entry);
      await response.send("ok");
    });
    await svc.start();
    return { svc, handled };
  }

  function caller(
    lin: Lineage | undefined,
    identity = true,
    extra: ReadonlyArray<PromptInterceptor> = [],
  ): Agents {
    return new Agents({
      nc,
      ...(identity ? { identity: { signer } } : {}),
      interceptors: [...(lin ? [lin.caller] : []), ...extra],
    });
  }

  async function handle(agents: Agents, svc: AgentService): Promise<Agent> {
    const agent = await agents.lookupInstance(svc.instanceId);
    if (!agent) throw new Error("service not found");
    return agent;
  }

  it("publishes one signed record before the prompt and adds the pair to the envelope", async () => {
    const lin = lineage(RECORDS);
    const { svc, handled } = await host(lin, "record");
    const agents = caller(lin);
    const order: string[] = [];
    const records = capture(observer, RECORDS);
    const prompts = observer.subscribe(svc.subject.prompt);
    void (async () => {
      for await (const _m of prompts) order.push("prompt");
    })();
    const recordOrder = observer.subscribe(RECORDS);
    void (async () => {
      for await (const _m of recordOrder) order.push("record");
    })();
    await observer.flush();
    try {
      const agent = await handle(agents, svc);
      await drain(await agent.prompt("hello", { context: { label: "call-7" } }));
      await until(() => order.length === 2 && records.msgs.length === 1, "record and prompt");

      // The record is on the wire before the prompt it describes.
      expect(order).toEqual(["record", "prompt"]);
      const msg = records.msgs[0]!;
      const record = JSON.parse(dec.decode(msg.data)) as LineageRecord;
      // One id: the body's record_id, the signed nonce and Nats-Msg-Id.
      const header = parseSenderHeader(readSenderHeaderValue(msg.headers) ?? "");
      expect(header?.nonce).toBe(record.record_id);
      expect(msg.headers?.get("Nats-Msg-Id")).toBe(record.record_id);
      // Signed by the caller's own identity, which the body names too.
      const sender = await verifySender(msg, "stored");
      const self = await agents.selfId();
      expect(sender).toMatchObject({ trust: "verified", id: self });
      expect(record.agent).toBe(self);
      // A root: no ambient scope, so no parent and the node is its own root.
      expect(record.parent).toBeNull();
      expect(record.root).toBe(record.node);
      expect(record.target).toBe(svc.instanceId);
      expect(record.label).toBe("call-7");

      // The host adopted the pair from the envelope's unknown fields and
      // ran the handler inside it.
      expect(handled).toHaveLength(1);
      expect(handled[0]!.envelope.extras).toEqual({
        [NODE_FIELD]: record.node,
        [ROOT_FIELD]: record.root,
      });
      expect(handled[0]!.scope).toEqual({ node: record.node, root: record.root });
      expect(lin.counts).toMatchObject({ published: 1, dropped: 0, adopted: 1, minted: 0 });
    } finally {
      records.stop();
      prompts.unsubscribe();
      recordOrder.unsubscribe();
      await agents.close();
      await svc.stop();
    }
  });

  it("hands the host interceptor the envelope, the sender, the subject and the headers", async () => {
    const lin = lineage(RECORDS);
    const seen: RequestInterceptorContext[] = [];
    const spy: RequestInterceptor = {
      async aroundRequest(ctx, next) {
        seen.push(ctx);
        await next();
      },
    };
    const { svc, handled } = await host(lin, "ctx", { extra: [spy] });
    const agents = caller(lin);
    try {
      await drain(await (await handle(agents, svc)).prompt("hi"));
      expect(seen).toHaveLength(1);
      const ctx = seen[0]!;
      expect(ctx.subject).toBe(svc.subject.prompt);
      expect(ctx.sender).toMatchObject({ trust: "verified", id: await agents.selfId() });
      expect(ctx.headers?.get(NODE_HEADER)).toBe(handled[0]!.scope?.node);
      expect(ctx.envelope.prompt).toBe("hi");
      expect(ctx.envelope.extras?.[NODE_FIELD]).toBe(handled[0]!.scope?.node);
    } finally {
      await agents.close();
      await svc.stop();
    }
  });

  it("refuses a half pair with 400 before the ack, and never runs the handler", async () => {
    const lin = lineage(RECORDS);
    const { svc, handled } = await host(lin, "half");
    try {
      const node = "a".repeat(32);
      const msgs = await rawStream(
        nc,
        svc.subject.prompt,
        JSON.stringify({ prompt: "x", [NODE_FIELD]: node }),
      );
      // Error frame, then the terminator — no ack, no chunk.
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.headers?.get("Nats-Service-Error-Code")).toBe("400");
      expect(msgs[0]!.headers?.get("Nats-Service-Error")).toContain("must be given together");
      expect(msgs[1]!.data.length).toBe(0);
      expect(handled).toHaveLength(0);
    } finally {
      await svc.stop();
    }
  });

  it("mints a root when the envelope carries no pair", async () => {
    const lin = lineage(RECORDS);
    const { svc, handled } = await host(lin, "mint");
    const plain = caller(undefined, false);
    try {
      await drain(await (await handle(plain, svc)).prompt("plain"));
      expect(handled).toHaveLength(1);
      const scope = handled[0]!.scope;
      expect(scope?.node).toMatch(/^[0-9a-f]{32}$/);
      expect(scope?.root).toBe(scope?.node);
      expect(handled[0]!.envelope.extras).toBeUndefined();
      expect(lin.counts).toMatchObject({ adopted: 0, minted: 1 });
    } finally {
      await plain.close();
      await svc.stop();
    }
  });

  it("carries the scope into a client used inside the handler", async () => {
    const lin = lineage(RECORDS);
    const inner = await host(lin, "inner");
    const innerClient = caller(lin);
    const outer = await host(lin, "outer", {
      onPrompt: async () => {
        await drain(await (await handle(innerClient, inner.svc)).prompt("nested"));
      },
    });
    const outerClient = caller(lin);
    const records = capture(observer, RECORDS);
    await observer.flush();
    try {
      await drain(await (await handle(outerClient, outer.svc)).prompt("top"));
      await until(() => records.msgs.length === 2, "two records");
      const [top, nested] = records.msgs.map(
        (m) => JSON.parse(dec.decode(m.data)) as LineageRecord,
      );
      const outerScope = outer.handled[0]!.scope!;
      const innerScope = inner.handled[0]!.scope!;
      // The nested prompt is a child of the outer execution, in its tree.
      expect(top!.node).toBe(outerScope.node);
      expect(nested!.parent).toBe(outerScope.node);
      expect(nested!.root).toBe(outerScope.root);
      expect(innerScope).toEqual({ node: nested!.node, root: outerScope.root });
    } finally {
      records.stop();
      await innerClient.close();
      await outerClient.close();
      await inner.svc.stop();
      await outer.svc.stop();
    }
  });

  it("runs in the context prompt() was called in, not the one the stream is iterated in", async () => {
    const lin = lineage(RECORDS);
    const { svc, handled } = await host(lin, "context");
    const agents = caller(lin);
    const records = capture(observer, RECORDS);
    await observer.flush();
    try {
      const agent = await handle(agents, svc);
      const parent: LineageScope = { node: "b".repeat(32), root: "c".repeat(32) };
      const stream = await lin.within(parent, () => agent.prompt("later"));
      // Iterated outside any scope.
      await lin.within({ node: "d".repeat(32), root: "d".repeat(32) }, () => drain(stream));
      await until(() => records.msgs.length === 1, "one record");
      const record = JSON.parse(dec.decode(records.msgs[0]!.data)) as LineageRecord;
      expect(record.parent).toBe(parent.node);
      expect(record.root).toBe(parent.root);
      expect(handled[0]!.scope).toEqual({ node: record.node, root: parent.root });
    } finally {
      records.stop();
      await agents.close();
      await svc.stop();
    }
  });

  it("runs no interceptor for a prompt that is never iterated", async () => {
    const lin = lineage(RECORDS);
    const { svc, handled } = await host(lin, "idle");
    const agents = caller(lin);
    const records = capture(observer, RECORDS);
    await observer.flush();
    try {
      await (await handle(agents, svc)).prompt("never sent");
      await new Promise((r) => setTimeout(r, 300));
      expect(records.msgs).toHaveLength(0);
      expect(handled).toHaveLength(0);
      expect(lin.counts).toMatchObject({ published: 0, dropped: 0 });
    } finally {
      records.stop();
      await agents.close();
      await svc.stop();
    }
  });

  it("drops the record without a signer, and still sends the pair", async () => {
    const lin = lineage(RECORDS);
    const { svc, handled } = await host(lin, "unsigned");
    const agents = caller(lin, false);
    try {
      await drain(await (await handle(agents, svc)).prompt("unsigned"));
      expect(lin.counts).toMatchObject({ published: 0, dropped: 1, adopted: 1 });
      expect(handled[0]!.scope?.node).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await agents.close();
      await svc.stop();
    }
  });

  it("reports the counts on every heartbeat and status reply", async () => {
    const lin = lineage(RECORDS);
    const { svc } = await host(lin, "counts");
    const signed = caller(lin);
    const unsigned = caller(lin, false);
    try {
      await drain(await (await handle(signed, svc)).prompt("one"));
      await drain(await (await handle(unsigned, svc)).prompt("two"));
      const status = await (await handle(signed, svc)).status();
      expect(status.extras).toMatchObject({ lineage_published: 1, lineage_dropped: 1 });
    } finally {
      await signed.close();
      await unsigned.close();
      await svc.stop();
    }
    // The heartbeat reads the provider when each beat is built.
    const beat = observer.subscribe("agents.hb.lineage.o.counts-hb", { max: 1 });
    await observer.flush();
    const svc2 = new AgentService({
      nc,
      agent: "lineage",
      owner: "o",
      name: "counts-hb",
      heartbeatExtras: lin.heartbeatExtras,
    });
    svc2.onPrompt(() => undefined);
    await svc2.start();
    try {
      for await (const m of beat) {
        const payload = decodeHeartbeatPayload(JSON.parse(dec.decode(m.data)));
        expect(payload?.extras).toMatchObject({ lineage_published: 1, lineage_dropped: 1 });
      }
    } finally {
      await svc2.stop();
    }
  });

  it("fails the prompt, and sends nothing, when an interceptor throws", async () => {
    const lin = lineage(RECORDS);
    const { svc, handled } = await host(lin, "throws");
    const failing: PromptInterceptor = {
      beforePrompt() {
        throw new Error("interceptor says no");
      },
    };
    const agents = caller(undefined, true, [failing]);
    try {
      const stream = await (await handle(agents, svc)).prompt("x");
      await expect(drain(stream)).rejects.toThrow("interceptor says no");
      await new Promise((r) => setTimeout(r, 200));
      expect(handled).toHaveLength(0);
    } finally {
      await agents.close();
      await svc.stop();
    }
  });

  it("refuses an interceptor that sets a protocol field or the Agent-Sender header", async () => {
    const lin = lineage(RECORDS);
    const { svc } = await host(lin, "reserved");
    const field: PromptInterceptor = { beforePrompt: () => ({ fields: { prompt: "hijack" } }) };
    const header: PromptInterceptor = {
      beforePrompt: () => ({ headers: { "agent-sender": "{}" } }),
    };
    const a = caller(undefined, true, [field]);
    const b = caller(undefined, true, [header]);
    try {
      await expect(drain(await (await handle(a, svc)).prompt("x"))).rejects.toThrow(NatsAgentError);
      await expect(drain(await (await handle(b, svc)).prompt("x"))).rejects.toThrow(
        /Agent-Sender header/,
      );
    } finally {
      await a.close();
      await b.close();
      await svc.stop();
    }
  });

  it("publishes nothing for a prompt that fails the size check", async () => {
    const lin = lineage(RECORDS);
    // 1 KB: the prompt alone fits with room for its header; with a bulky
    // extra field it no longer does, which only the check made at publish
    // time — after the first phase, before the second — can see.
    const { svc, handled } = await host(lin, "too-big", { maxPayload: "1KB" });
    const bulky: PromptInterceptor = {
      beforePrompt: () => ({ fields: { x_bulk: "b".repeat(2_000) } }),
    };
    const agents = caller(lin, true, [bulky]);
    const records = capture(observer, RECORDS);
    const prompts = capture(observer, svc.subject.prompt);
    await observer.flush();
    try {
      const stream = await (await handle(agents, svc)).prompt("hi");
      await expect(drain(stream)).rejects.toThrow(PayloadTooLargeError);
      await new Promise((r) => setTimeout(r, 300));
      expect(records.msgs).toHaveLength(0);
      expect(prompts.msgs).toHaveLength(0);
      expect(handled).toHaveLength(0);
      expect(lin.counts).toMatchObject({ published: 0, dropped: 0 });
    } finally {
      records.stop();
      prompts.stop();
      await agents.close();
      await svc.stop();
    }
  });

  it("hands beforePublish the same context and what beforePrompt returned", async () => {
    const lin = lineage(RECORDS);
    const { svc } = await host(lin, "phases");
    const seen: Array<{ phase: string; ctx: PromptInterceptorContext; extras?: unknown }> = [];
    const state = { planned: "by phase one" };
    const returned: PromptExtras = { fields: { x_phase: 1 }, state };
    const phases: PromptInterceptor = {
      beforePrompt(ctx) {
        seen.push({ phase: "beforePrompt", ctx });
        return returned;
      },
      beforePublish(ctx, extras) {
        seen.push({ phase: "beforePublish", ctx, extras });
      },
    };
    // No first-phase result: the second phase gets `undefined`.
    const silent: PromptInterceptor = {
      beforePrompt: () => undefined,
      beforePublish(ctx, extras) {
        seen.push({ phase: "silent", ctx, extras });
      },
    };
    const agents = caller(undefined, true, [phases, silent]);
    try {
      await drain(await (await handle(agents, svc)).prompt("hi", { context: { k: "v" } }));
      expect(seen.map((s) => s.phase)).toEqual(["beforePrompt", "beforePublish", "silent"]);
      expect(seen[1]!.ctx).toBe(seen[0]!.ctx);
      expect(seen[2]!.ctx).toBe(seen[0]!.ctx);
      expect(seen[1]!.extras).toBe(returned);
      expect((seen[1]!.extras as PromptExtras).state).toBe(state);
      expect(seen[2]!.extras).toBeUndefined();
      expect(seen[0]!.ctx.context).toEqual({ k: "v" });
    } finally {
      await agents.close();
      await svc.stop();
    }
  });

  it("logs a beforePublish failure and still publishes the prompt", async () => {
    const lin = lineage(RECORDS);
    const { svc, handled } = await host(lin, "phase-two-throws");
    const errors: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (msg, ctx) => {
        errors.push({ msg, ...(ctx !== undefined ? { ctx } : {}) });
      },
    };
    const failing: PromptInterceptor = {
      beforePrompt: () => undefined,
      beforePublish() {
        throw new Error("secret detail");
      },
    };
    const agents = new Agents({
      nc,
      identity: { signer },
      logger,
      interceptors: [failing, lin.caller],
    });
    try {
      await drain(await (await handle(agents, svc)).prompt("still sent"));
      // The prompt went out, and the interceptor after the failing one ran.
      expect(handled).toHaveLength(1);
      expect(lin.counts).toMatchObject({ published: 1, dropped: 0 });
      expect(errors).toHaveLength(1);
      expect(errors[0]!.msg).toContain("beforePublish failed");
      expect(JSON.stringify(errors)).not.toContain("secret detail");
    } finally {
      await agents.close();
      await svc.stop();
    }
  });

  it("merges several interceptors in order, the later one winning a key", async () => {
    const lin = lineage(RECORDS);
    const { svc, handled } = await host(lin, "merge");
    const first: PromptInterceptor = {
      beforePrompt: () => ({ fields: { a: 1, shared: "first" } }),
    };
    // Asynchronous: a Promise is awaited like a plain value.
    const second: PromptInterceptor = {
      beforePrompt: () => Promise.resolve({ fields: { b: 2, shared: "second" } }),
    };
    const nothing: PromptInterceptor = { beforePrompt: () => undefined };
    const agents = caller(undefined, false, [first, nothing, second]);
    try {
      await drain(await (await handle(agents, svc)).prompt("x"));
      // The host minted: the fields are unknown to the lineage pair.
      expect(handled[0]!.envelope.extras).toEqual({ a: 1, b: 2, shared: "second" });
    } finally {
      await agents.close();
      await svc.stop();
    }
  });

  it("answers the code of a RequestRejectedError", async () => {
    const lin = lineage(RECORDS);
    const deny: RequestInterceptor = {
      aroundRequest: () => Promise.reject(new RequestRejectedError(403, "not you")),
    };
    const { svc } = await host(lin, "deny", { extra: [deny] });
    const agents = caller(lin);
    try {
      const err = await drain(await (await handle(agents, svc)).prompt("x")).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ServiceError);
      expect(err).toMatchObject({ code: 403, description: "not you" });
    } finally {
      await agents.close();
      await svc.stop();
    }
  });
});

describe.skipIf(!bin)("publishSigned with a caller-chosen nonce", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf") });
    nc = await connect({
      servers: server.url,
      authenticator: nkeyAuthenticator(enc.encode(ALICE.seed)),
      reconnect: false,
    });
  });
  afterAll(async () => {
    await nc.close();
    await server.stop();
  });

  it("signs with the nonce and sets it as Nats-Msg-Id", async () => {
    const agents = new Agents({ nc, identity: { signer: signerFromSeed(ALICE.seed) } });
    const seen = capture(nc, "signed.nonce");
    await nc.flush();
    try {
      await agents.publishSigned("signed.nonce", "body", { nonce: "record-1_A" });
      await until(() => seen.msgs.length === 1, "the signed message");
      const msg = seen.msgs[0]!;
      expect(parseSenderHeader(readSenderHeaderValue(msg.headers) ?? "")?.nonce).toBe("record-1_A");
      expect(msg.headers?.get("Nats-Msg-Id")).toBe("record-1_A");
      expect(await verifySender(msg, "stored")).toMatchObject({ trust: "verified" });
      const value = await agents.signSender("signed.nonce", "body", { nonce: "other" });
      expect(parseSenderHeader(value)?.nonce).toBe("other");
    } finally {
      seen.stop();
      await agents.close();
    }
  });

  it("refuses a nonce outside the header grammar", async () => {
    const agents = new Agents({ nc, identity: { signer: signerFromSeed(ALICE.seed) } });
    try {
      for (const nonce of ["", "has space", "x".repeat(65), "dot.ted"]) {
        await expect(agents.publishSigned("signed.nonce", "body", { nonce })).rejects.toThrow(
          IdentityError,
        );
      }
    } finally {
      await agents.close();
    }
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import {
  Agent,
  parseSenderHeader,
  PayloadTooLargeError,
  readSenderHeaderValue,
  signerFromSeed,
} from "../../src/index.js";
import { IdentityContext } from "../../src/identity/context.js";
import { buildAgentInfo } from "../../src/discovery/agent-info.js";
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
const ALICE = keys.users["alice"]!;
const enc = new TextEncoder();
const SUBJECT = "hunt.prompt";

function info(maxPayload?: string) {
  return buildAgentInfo({
    name: "agents",
    id: "i",
    version: "0.1.0",
    description: "",
    metadata: { agent: "hunt", owner: "o", session: "s", protocol_version: "0.3" },
    endpoints: [
      {
        name: "prompt",
        subject: SUBJECT,
        queue_group: "agents",
        metadata: {
          attachments_ok: "true",
          ...(maxPayload !== undefined ? { max_payload: maxPayload } : {}),
        },
      },
    ],
  })!;
}

/**
 * An edge record is a claim that a prompt went out. It must not outrun
 * the prompt, and it must not exist at all for a prompt that never goes
 * out — one whose stream is never iterated, or that validation rejects.
 */
describe.skipIf(!bin)("edge record timing", () => {
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function tracedAgent(agentInfo = info()): Agent {
    return new Agent(
      nc,
      agentInfo,
      60_000,
      undefined,
      new IdentityContext(nc, { signer: signerFromSeed(ALICE.seed) }),
      {},
    );
  }

  it("precedes the prompt on the wire", async () => {
    const order: string[] = [];
    const edges = nc.subscribe("TRACE.edges");
    const prompts = nc.subscribe(SUBJECT);
    void (async () => {
      for await (const _m of edges) order.push("edge");
    })();
    void (async () => {
      for await (const m of prompts) {
        order.push("prompt");
        if (m.reply) nc.publish(m.reply, "");
      }
    })();
    await nc.flush();

    const s = await tracedAgent().prompt("hi");
    for await (const _m of s) {
      /* drain */
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(order).toEqual(["edge", "prompt"]);
  });

  it("carries one id: record_id, Nats-Msg-Id and the signed nonce agree", async () => {
    // A reader de-duplicates on (signing user, record_id); a stream on
    // Nats-Msg-Id; the signature binds the nonce. All three must be the
    // same value or the record is counted differently by each.
    const edges: Msg[] = [];
    const sub = nc.subscribe("TRACE.edges");
    const prompts = nc.subscribe(SUBJECT);
    void (async () => {
      for await (const m of sub) edges.push(m);
    })();
    void (async () => {
      for await (const m of prompts) if (m.reply) nc.publish(m.reply, "");
    })();
    await nc.flush();

    const s = await tracedAgent().prompt("hi");
    for await (const _m of s) {
      /* drain */
    }
    await new Promise((r) => setTimeout(r, 400));
    sub.unsubscribe();
    prompts.unsubscribe();

    expect(edges).toHaveLength(1);
    const record = JSON.parse(new TextDecoder().decode(edges[0]!.data)) as Record<string, unknown>;
    const sender = parseSenderHeader(readSenderHeaderValue(edges[0]!.headers) ?? "");
    expect(sender?.nonce).toBe(record["record_id"]);
    expect(edges[0]!.headers?.get("Nats-Msg-Id")).toBe(record["record_id"]);
  });

  it("is stamped with the time the prompt went out, not the time it was planned", async () => {
    const records: unknown[] = [];
    const edges = nc.subscribe("TRACE.edges");
    const prompts = nc.subscribe(SUBJECT);
    void (async () => {
      for await (const m of edges) records.push(JSON.parse(new TextDecoder().decode(m.data)));
    })();
    void (async () => {
      for await (const m of prompts) if (m.reply) nc.publish(m.reply, "");
    })();
    await nc.flush();

    const s = await tracedAgent().prompt("hi"); // planned now …
    await new Promise((r) => setTimeout(r, 1100)); // … a whole second passes …
    const sentAt = Math.floor(Date.now() / 1000);
    for await (const _m of s) {
      /* … sent now */
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(records).toHaveLength(1);
    expect((records[0] as { ts: number }).ts).toBeGreaterThanOrEqual(sentAt);
  });

  it("is not published when the caller never iterates the stream", async () => {
    const seen: unknown[] = [];
    const edges = nc.subscribe("TRACE.edges");
    void (async () => {
      for await (const _m of edges) seen.push(1);
    })();
    await nc.flush();

    await tracedAgent().prompt("hi"); // returned, never iterated
    await new Promise((r) => setTimeout(r, 400));
    expect(seen.length).toBe(0);
  });

  it("is not published when the request header cannot be built at publish time", async () => {
    const seen: unknown[] = [];
    const edges = nc.subscribe("TRACE.edges");
    void (async () => {
      for await (const _m of edges) seen.push(1);
    })();
    await nc.flush();

    // The prompt's header is planned twice: once in `prompt()` (the exact
    // size re-check) and again at publish time, immediately before the
    // request goes out — a reconnect in between can invalidate the
    // identity. Fail only the publish-time plan for the prompt subject; the
    // edge record's own plan (another subject) is left alone so the edge
    // WOULD go out if it were published first.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with an explicit `this` below
    const real = IdentityContext.prototype.plan;
    let promptPlans = 0;
    vi.spyOn(IdentityContext.prototype, "plan").mockImplementation(async function (
      this: IdentityContext,
      sub: string,
      requireSigned: boolean,
    ) {
      if (sub === SUBJECT && ++promptPlans === 2) throw new Error("identity lost on reconnect");
      return real.call(this, sub, requireSigned);
    });

    const s = await tracedAgent().prompt("hi");
    await expect(
      (async () => {
        for await (const _m of s) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("identity lost on reconnect");
    await new Promise((r) => setTimeout(r, 400));
    expect(promptPlans).toBe(2);
    expect(seen.length).toBe(0);
  });

  it("is not published when validation rejects the prompt", async () => {
    const seen: unknown[] = [];
    const edges = nc.subscribe("TRACE.edges");
    void (async () => {
      for await (const _m of edges) seen.push(1);
    })();
    await nc.flush();

    // Text-only prompts validate synchronously (§5.4), so the throw is not
    // a rejected promise.
    expect(() => tracedAgent(info("16B")).prompt("x".repeat(10_000))).toThrow(PayloadTooLargeError);
    await new Promise((r) => setTimeout(r, 400));
    expect(seen.length).toBe(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { Agent, PayloadTooLargeError, signerFromSeed } from "../../src/index.js";
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

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { Agent, signerFromSeed, traceRecordCounts } from "../../src/index.js";
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
const SUBJECT = "count.prompt";

const info = buildAgentInfo({
  name: "agents",
  id: "i",
  version: "0.1.0",
  description: "",
  metadata: { agent: "count", owner: "o", session: "s", protocol_version: "0.3" },
  endpoints: [
    {
      name: "prompt",
      subject: SUBJECT,
      queue_group: "agents",
      metadata: { attachments_ok: "true" },
    },
  ],
})!;

/**
 * A record that was never published leaves nothing behind, so the SDK
 * counts what it published and what it could not, for the whole process,
 * and the agent service reports both on its heartbeat. The counters are
 * process-wide, so every assertion here is on the delta across one prompt.
 */
describe.skipIf(!bin)("trace record counts", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf") });
    nc = await connect({
      servers: server.url,
      authenticator: nkeyAuthenticator(enc.encode(ALICE.seed)),
      reconnect: false,
    });
    // Answer every prompt so the streams below complete.
    const prompts = nc.subscribe(SUBJECT);
    void (async () => {
      for await (const m of prompts) if (m.reply) nc.publish(m.reply, "");
    })();
    await nc.flush();
  });
  afterAll(async () => {
    await nc.close();
    await server.stop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function agent(identity: IdentityContext | undefined, edgeSubject?: string | null): Agent {
    return new Agent(
      nc,
      info,
      60_000,
      undefined,
      identity,
      edgeSubject === undefined ? {} : { edgeSubject },
    );
  }

  async function drain(a: Agent): Promise<void> {
    const s = await a.prompt("hi");
    for await (const _m of s) {
      /* drain */
    }
  }

  it("counts a record handed to the connection as published", async () => {
    const before = traceRecordCounts();
    await drain(agent(new IdentityContext(nc, { signer: signerFromSeed(ALICE.seed) })));
    const after = traceRecordCounts();
    expect(after.published - before.published).toBe(1);
    expect(after.dropped - before.dropped).toBe(0);
  });

  it("counts a record due without an identity to sign it as dropped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const before = traceRecordCounts();
    await drain(agent(undefined));
    const after = traceRecordCounts();
    expect(after.published - before.published).toBe(0);
    expect(after.dropped - before.dropped).toBe(1);
  });

  it("counts nothing for an unsigned prompt that never goes out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const before = traceRecordCounts();
    await agent(undefined).prompt("hi"); // returned, never iterated
    await new Promise((r) => setTimeout(r, 100));
    expect(traceRecordCounts()).toEqual(before);
  });

  it("counts a record whose publish threw as dropped, and the prompt still goes out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const realPublish = nc.publish.bind(nc);
    vi.spyOn(nc, "publish").mockImplementation((subject, data, opts) => {
      if (subject === "TRACE.edges") throw new Error("connection draining");
      return realPublish(subject, data, opts);
    });
    const before = traceRecordCounts();
    await drain(agent(new IdentityContext(nc, { signer: signerFromSeed(ALICE.seed) })));
    const after = traceRecordCounts();
    expect(after.published - before.published).toBe(0);
    expect(after.dropped - before.dropped).toBe(1);
  });

  it("counts nothing in propagate-only mode, where no record is due", async () => {
    const before = traceRecordCounts();
    await drain(agent(new IdentityContext(nc, { signer: signerFromSeed(ALICE.seed) }), null));
    expect(traceRecordCounts()).toEqual(before);
  });

  it("returns a frozen snapshot", () => {
    expect(Object.isFrozen(traceRecordCounts())).toBe(true);
  });
});

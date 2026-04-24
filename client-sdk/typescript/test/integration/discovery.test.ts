import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { connect as natsConnect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { Svcm } from "@nats-io/services";
import { Agents } from "../../src/index.js";
import { ReferenceAgent } from "../../src/testing/reference-agent.js";

const natsUrl = inject("natsUrl");

describe.skipIf(!natsUrl)("Agents.discover", () => {
  let nc: NatsConnection;
  let client: Agents;
  const agents: ReferenceAgent[] = [];

  beforeAll(async () => {
    nc = await natsConnect({ servers: natsUrl! });
  });

  afterAll(async () => {
    await nc.close();
  });

  beforeEach(() => {
    client = new Agents({ nc });
  });

  afterEach(async () => {
    await client.close();
    await Promise.all(agents.splice(0).map((a) => a.stop()));
  });

  async function startAgent(
    overrides: Partial<ConstructorParameters<typeof ReferenceAgent>[0]> = {},
  ): Promise<ReferenceAgent> {
    const agent = new ReferenceAgent({
      nc,
      agent: "ref-agent",
      owner: "testers",
      name: `inst-${Math.random().toString(36).slice(2, 8)}`,
      heartbeatIntervalS: 1,
      ...overrides,
    });
    await agent.start();
    agents.push(agent);
    return agent;
  }

  it("finds a spec-compliant agent", async () => {
    const agent = await startAgent();
    const found = await client.discover({ timeoutMs: 1000 });
    const match = found.find((a) => a.instanceId === agent.instanceId);
    expect(match).toBeDefined();
    expect(match!.agent).toBe("ref-agent");
    expect(match!.owner).toBe("testers");
    expect(match!.protocolVersion).toBe("0.2");
    expect(match!.promptEndpoint.subject).toBe(agent.promptSubject);
    expect(match!.promptEndpoint.queueGroup).toBe("agents");
    expect(match!.promptEndpoint.maxPayloadBytes).toBe(1024 * 1024);
    expect(match!.promptEndpoint.attachmentsOk).toBe(true);
  });

  it("finds multiple agents with distinct identities", async () => {
    const a1 = await startAgent({ agent: "ref-a", name: "one" });
    const a2 = await startAgent({ agent: "ref-b", name: "two" });
    const found = await client.discover({ timeoutMs: 1000 });
    const ids = new Set(found.map((f) => f.instanceId));
    expect(ids.has(a1.instanceId)).toBe(true);
    expect(ids.has(a2.instanceId)).toBe(true);
  });

  it("honors client-side filter by agent", async () => {
    await startAgent({ agent: "ref-keep", name: "keep" });
    await startAgent({ agent: "ref-skip", name: "skip" });
    const found = await client.discover({
      timeoutMs: 1000,
      filter: { agent: "ref-keep" },
    });
    expect(found.length).toBe(1);
    expect(found[0]!.agent).toBe("ref-keep");
  });

  it("honors filter by owner + name", async () => {
    await startAgent({ agent: "ref-agent", owner: "alice", name: "mine" });
    await startAgent({ agent: "ref-agent", owner: "bob", name: "mine" });
    const aliceOnly = await client.discover({
      timeoutMs: 1000,
      filter: { owner: "alice" },
    });
    expect(aliceOnly.every((a) => a.owner === "alice")).toBe(true);
    const mineOnly = await client.discover({
      timeoutMs: 1000,
      filter: { name: "mine" },
    });
    expect(mineOnly.length).toBeGreaterThanOrEqual(2);
  });

  it("does not return non-agent micro-services on the same NATS", async () => {
    const svcm = new Svcm(nc);
    const other = await svcm.add({
      name: "UnrelatedService",
      version: "1.0.0",
      description: "not an agent",
    });
    other.addEndpoint("echo", {
      subject: "unrelated.echo",
      handler: (_err, msg) => msg.respond(""),
    });
    try {
      await startAgent();
      const found = await client.discover({ timeoutMs: 1000 });
      expect(found.every((a) => a.agent === "ref-agent")).toBe(true);
    } finally {
      await other.stop();
    }
  });

  it("subscribes to the heartbeat wildcard BEFORE the first $SRV.PING (§8.5)", async () => {
    // Fresh client that hasn't discovered yet. Starting it should
    // establish the heartbeat subscription and flush BEFORE sending PING —
    // so the agent's immediate post-start heartbeat is caught.
    const freshClient = new Agents({ nc });
    try {
      // discover() is the path that implicitly enforces subscribe-before-PING.
      const discoverPromise = freshClient.discover({ timeoutMs: 500 });
      // Start the agent AFTER discover has begun — this means the agent's
      // publisher races with the tracker. If the tracker subscribes before
      // PING (per §8.5), the agent's heartbeat is caught.
      const agent = await startAgent({ heartbeatIntervalS: 1 });
      await discoverPromise;
      // Wait for the next heartbeat via the tracker's onHeartbeat hook —
      // deterministic rather than timing-based.
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          unsub();
          reject(new Error("no heartbeat within 2s — subscribe-before-discover failed"));
        }, 2_000);
        const unsub = freshClient.onHeartbeat(agent.instanceId, () => {
          clearTimeout(t);
          unsub();
          resolve();
        });
      });
      expect(freshClient.liveness(agent.instanceId)).not.toBeNull();
    } finally {
      await freshClient.close();
    }
  });

  it("discover() returns a live Agent carrying the prompt subject", async () => {
    const agent = await startAgent();
    const [discovered] = await client.discover({ timeoutMs: 1000 });
    expect(discovered!.instanceId).toBe(agent.instanceId);
    expect(discovered!.promptSubject).toBe(agent.promptSubject);
  });
});

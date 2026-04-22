import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { connect as natsConnect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { attach, type Client, type HeartbeatPayload } from "../../src/index.js";
import { ReferenceAgent } from "../../src/testing/reference-agent.js";

const natsUrl = inject("natsUrl");

function waitForHeartbeat(
  client: Client,
  instanceId: string,
  timeoutMs = 3_000,
): Promise<HeartbeatPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`no heartbeat for ${instanceId} within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsub = client.onHeartbeat(instanceId, (payload) => {
      clearTimeout(timer);
      unsub();
      resolve(payload);
    });
  });
}

describe.skipIf(!natsUrl)("heartbeat tracking", () => {
  let nc: NatsConnection;
  let client: Client;
  const agents: ReferenceAgent[] = [];

  beforeAll(async () => {
    nc = await natsConnect({ servers: natsUrl! });
  });

  afterAll(async () => {
    await nc.close();
  });

  beforeEach(async () => {
    client = attach({ name: "heartbeat-test", nc });
    // Prime the tracker BEFORE starting any reference agents so their
    // immediate first heartbeat is captured (§8.5).
    await client.startTracking();
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
      agent: "hb-agent",
      owner: "testers",
      name: `inst-${Math.random().toString(36).slice(2, 8)}`,
      heartbeatIntervalS: 1,
      ...overrides,
    });
    await agent.start();
    agents.push(agent);
    return agent;
  }

  it("reports online after a heartbeat is observed", async () => {
    const agent = await startAgent({ heartbeatIntervalS: 1 });
    await waitForHeartbeat(client, agent.instanceId);
    const liveness = client.liveness(agent.instanceId);
    expect(liveness).not.toBeNull();
    expect(liveness!.intervalS).toBe(1);
    expect(liveness!.isOnline).toBe(true);
    expect(liveness!.lastSeen).toBeInstanceOf(Date);
  });

  it("onHeartbeat callback fires for the target instance", async () => {
    const agent = await startAgent({ heartbeatIntervalS: 1 });
    let count = 0;
    const unsub = client.onHeartbeat(agent.instanceId, (payload) => {
      expect(payload.instanceId).toBe(agent.instanceId);
      count += 1;
    });
    await new Promise((r) => setTimeout(r, 1_500));
    unsub();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("tracks multiple instances with the same identity tuple separately", async () => {
    const shared = {
      agent: "hb-dup",
      owner: "testers",
      name: "same",
      heartbeatIntervalS: 1,
    } as const;
    const a = await startAgent(shared);
    const b = await startAgent(shared);
    expect(a.instanceId).not.toBe(b.instanceId);
    await Promise.all([
      waitForHeartbeat(client, a.instanceId),
      waitForHeartbeat(client, b.instanceId),
    ]);
    expect(client.liveness(a.instanceId)).not.toBeNull();
    expect(client.liveness(b.instanceId)).not.toBeNull();
  });

  it("reports offline after missing the threshold (§8.2)", async () => {
    const agent = await startAgent({ heartbeatIntervalS: 1 });
    const id = agent.instanceId; // capture before we stop the agent
    await waitForHeartbeat(client, id);
    expect(client.liveness(id)!.isOnline).toBe(true);
    // Stop the agent → no more heartbeats.
    await agent.stop();
    // Wait longer than 3 × intervalS.
    await new Promise((r) => setTimeout(r, 3_500));
    const liveness = client.liveness(id);
    expect(liveness).not.toBeNull();
    expect(liveness!.isOnline).toBe(false);
  });

  it("ping() returns true for a live agent, false for an unknown id", async () => {
    const agent = await startAgent();
    const ok = await client.ping(agent.instanceId, { timeoutMs: 500 });
    expect(ok).toBe(true);
    const bogus = await client.ping("NOT-A-REAL-ID", { timeoutMs: 300 });
    expect(bogus).toBe(false);
  });

  it("preserves unknown fields on the heartbeat via `extras` (§12 forward-compat)", async () => {
    const agent = await startAgent({ heartbeatIntervalS: 1 });
    const hb = await waitForHeartbeat(client, agent.instanceId);
    expect(hb.agent).toBe("hb-agent");
    expect(hb.owner).toBe("testers");
    expect(hb.intervalS).toBe(1);
    expect(hb.extras).toEqual({}); // reference agent emits no extras yet
  });
});

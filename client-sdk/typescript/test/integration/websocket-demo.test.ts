// Live WebSocket round-trip against demo.nats.io.
//
// Gated behind TEST_REMOTE_WS=1 because it hits the public internet — leaving
// it opt-in keeps `bun run test:integration` hermetic when demo.nats.io is
// slow, unreachable, or the runner is offline. The test also self-skips on
// runtimes without a global WebSocket (Node < 22.4 without the flag).
//
// The SDK no longer wraps connection setup — users call `wsconnect` (or
// `connect` for TCP) themselves and hand the resulting `NatsConnection` to
// `new Agents({ nc })`. This test exercises that integration path.

import { Empty, type Subscription, wsconnect } from "@nats-io/nats-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agents } from "../../src/index.js";

const DEMO_WSS_URL = "wss://demo.nats.io:8443";

const hasWebSocket = typeof WebSocket !== "undefined";
const optedIn = process.env.TEST_REMOTE_WS === "1";

describe.skipIf(!hasWebSocket || !optedIn)("Agents over WebSocket (demo.nats.io)", () => {
  let agents: Agents;

  beforeEach(async () => {
    const nc = await wsconnect({
      servers: DEMO_WSS_URL,
      timeout: 5_000,
      maxReconnectAttempts: 0,
    });
    agents = new Agents({ nc });
  });

  afterEach(async () => {
    const nc = agents.connection;
    await agents.close();
    await nc.close();
  });

  it("completes a pub/sub round-trip over wss", async () => {
    const nc = agents.connection;
    const subject = `synadia.agents.ws-smoke.${crypto.randomUUID()}`;

    const sub: Subscription = nc.subscribe(subject, { max: 1 });
    const received = (async () => {
      for await (const m of sub) return m;
      return undefined;
    })();

    nc.publish(subject, new TextEncoder().encode("hello over wss"));
    await nc.flush();

    const msg = await Promise.race([
      received,
      new Promise<never>((_, r) => setTimeout(() => r(new Error("no message within 5s")), 5_000)),
    ]);

    expect(msg).toBeDefined();
    expect(new TextDecoder().decode(msg!.data)).toBe("hello over wss");
  });

  it("completes a request/reply over the same connection", async () => {
    const nc = agents.connection;
    const subject = `synadia.agents.ws-smoke.req.${crypto.randomUUID()}`;

    const sub = nc.subscribe(subject, { max: 1 });
    (async () => {
      for await (const m of sub) m.respond(new TextEncoder().encode("pong"));
    })().catch(() => {
      /* swallowed: sub will close on teardown */
    });

    const reply = await nc.request(subject, Empty, { timeout: 5_000 });
    expect(new TextDecoder().decode(reply.data)).toBe("pong");
  });
});

// Print a live view of every reachable agent's heartbeat. Useful for
// debugging whether agents are actually publishing heartbeats at the
// expected cadence.

import { connect, type HeartbeatPayload } from "@synadia/agents";

async function main(): Promise<void> {
  const client = await connect({
    name: "liveness-demo",
    servers: process.env["NATS_URL"] ?? "nats://127.0.0.1:4222",
  });

  // Start the heartbeat wildcard subscription BEFORE discover().
  await client.startTracking();
  const agents = await client.discover({ timeoutMs: 2_000 });

  console.log(`tracking ${agents.length} agent(s). Press Ctrl+C to stop.\n`);
  for (const a of agents) {
    client.onHeartbeat(a.instanceId, (hb: HeartbeatPayload) => {
      const liveness = client.liveness(hb.instanceId);
      console.log(
        `[${hb.ts}] ${hb.agent}/${hb.owner}: interval=${hb.intervalS}s, online=${liveness?.isOnline ?? "unknown"}`,
      );
    });
  }

  // Print a summary every 5 seconds.
  const interval = setInterval(() => {
    console.log("\n--- status snapshot ---");
    for (const a of agents) {
      const l = client.liveness(a.instanceId);
      console.log(
        `  ${a.agent}/${a.name}: ` +
          (l ? `last_seen=${l.lastSeen.toISOString()}, online=${l.isOnline}` : "no heartbeat yet"),
      );
    }
    console.log("-----------------------\n");
  }, 5_000);

  process.on("SIGINT", () => {
    clearInterval(interval);
    void client.close().then(() => process.exit(0));
  });
}

void main().catch((err: unknown) => {
  console.error("liveness demo failed:", err);
  process.exit(1);
});

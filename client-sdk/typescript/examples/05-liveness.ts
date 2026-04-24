// Print a live view of every reachable agent's heartbeat. Useful for
// debugging whether agents are actually publishing heartbeats at the
// expected cadence.

import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type HeartbeatPayload } from "@synadia-ai/agents";

async function main(): Promise<void> {
  const nc = await natsConnect({
    servers: process.env["NATS_URL"] ?? "nats://127.0.0.1:4222",
  });
  const agents = new Agents({ nc });

  // Start the heartbeat wildcard subscription BEFORE discover().
  await agents.startTracking();
  const found = await agents.discover();

  console.log(`tracking ${found.length} agent(s). Press Ctrl+C to stop.\n`);
  for (const a of found) {
    agents.onHeartbeat(a.instanceId, (hb: HeartbeatPayload) => {
      const liveness = agents.liveness(hb.instanceId);
      console.log(
        `[${hb.ts}] ${hb.agent}/${hb.owner}: interval=${hb.intervalS}s, online=${liveness?.isOnline ?? "unknown"}`,
      );
    });
  }

  // Print a summary every 5 seconds.
  const interval = setInterval(() => {
    console.log("\n--- status snapshot ---");
    for (const a of found) {
      const l = agents.liveness(a.instanceId);
      console.log(
        `  ${a.agent}/${a.name}: ` +
          (l ? `last_seen=${l.lastSeen.toISOString()}, online=${l.isOnline}` : "no heartbeat yet"),
      );
    }
    console.log("-----------------------\n");
  }, 5_000);

  process.on("SIGINT", () => {
    clearInterval(interval);
    void agents
      .close()
      .then(() => nc.close())
      .then(() => process.exit(0));
  });
}

void main().catch((err: unknown) => {
  console.error("liveness demo failed:", err);
  process.exit(1);
});

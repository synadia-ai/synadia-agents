// Print a live view of every reachable agent's heartbeat. Useful for
// debugging whether agents are actually publishing heartbeats at the
// expected cadence.

import type { HeartbeatPayload } from "@synadia-ai/agents";
import { openExampleAgents, waitForTermination } from "./_connection";

async function main(): Promise<void> {
  const connection = await openExampleAgents();
  const { agents } = connection;
  let interval: ReturnType<typeof setInterval> | undefined;

  try {
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
    interval = setInterval(() => {
      console.log("\n--- status snapshot ---");
      for (const a of found) {
        const l = agents.liveness(a.instanceId);
        console.log(
          `  ${a.agent}/${a.name}: ` +
            (l
              ? `last_seen=${l.lastSeen.toISOString()}, online=${l.isOnline}`
              : "no heartbeat yet"),
        );
      }
      console.log("-----------------------\n");
    }, 5_000);

    await waitForTermination();
  } finally {
    if (interval) clearInterval(interval);
    await connection.close();
  }
}

void main().catch((err: unknown) => {
  console.error("liveness demo failed:", err);
  process.exit(1);
});

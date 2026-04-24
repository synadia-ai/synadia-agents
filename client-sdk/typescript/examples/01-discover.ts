// Enumerate every agent reachable on the NATS system and print a summary.
// Useful as a quick sanity check when bringing up a new environment.

import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

async function main(): Promise<void> {
  const nc = await natsConnect({
    servers: process.env["NATS_URL"] ?? "nats://127.0.0.1:4222",
  });
  const agents = new Agents({ nc });

  try {
    const found = await agents.discover();
    if (found.length === 0) {
      console.log("no agents found.");
      return;
    }
    console.log(`found ${found.length} agent(s):\n`);
    for (const a of found) {
      console.log(`  ${a.agent}/${a.owner}/${a.name}`);
      console.log(`    instance_id:      ${a.instanceId}`);
      console.log(`    protocol_version: ${a.protocolVersion}`);
      console.log(`    version:          ${a.version}`);
      console.log(`    description:      ${a.description}`);
      console.log(`    prompt subject:   ${a.promptEndpoint.subject}`);
      console.log(`    max_payload:      ${a.promptEndpoint.maxPayloadBytes ?? "unspecified"}`);
      console.log(`    attachments_ok:   ${a.promptEndpoint.attachmentsOk ?? "unspecified"}`);
      console.log();
    }
  } finally {
    await agents.close();
    await nc.close();
  }
}

void main().catch((err: unknown) => {
  console.error("discover failed:", err);
  process.exit(1);
});

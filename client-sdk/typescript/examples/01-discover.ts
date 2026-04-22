// Enumerate every agent reachable on the NATS system and print a summary.
// Useful as a quick sanity check when bringing up a new environment.

import { connect } from "@synadia/agents";

async function main(): Promise<void> {
  const client = await connect({
    name: "discover-demo",
    servers: process.env["NATS_URL"] ?? "nats://127.0.0.1:4222",
  });

  try {
    const agents = await client.discover({ timeoutMs: 2_000 });
    if (agents.length === 0) {
      console.log("no agents found.");
      return;
    }
    console.log(`found ${agents.length} agent(s):\n`);
    for (const a of agents) {
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
    await client.close();
  }
}

void main().catch((err: unknown) => {
  console.error("discover failed:", err);
  process.exit(1);
});

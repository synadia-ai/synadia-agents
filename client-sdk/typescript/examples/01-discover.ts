// Enumerate every agent reachable on the NATS system and print a summary.
// Useful as a quick sanity check when bringing up a new environment.

import { openExampleAgents } from "./_connection";

async function main(): Promise<void> {
  const connection = await openExampleAgents();
  const { agents } = connection;

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
    await connection.close();
  }
}

void main().catch((err: unknown) => {
  console.error("discover failed:", err);
  process.exit(1);
});

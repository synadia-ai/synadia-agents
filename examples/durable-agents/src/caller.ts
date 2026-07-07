// caller.ts — a tiny client that prompts the durable SRE agent and auto-answers the approval query.
// Doubles as the end-to-end verification driver and a demo entrypoint.
//   bun run src/caller.ts "checkout is slow — investigate and fix."
//   APPROVE=no bun run src/caller.ts     # deny the restart instead
import { connect } from "@nats-io/transport-node";
import { Agents, parseNatsUrl } from "@synadia-ai/agents";

const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const PROMPT = process.argv.slice(2).join(" ") || "checkout is slow — investigate and fix.";
const APPROVE = process.env.APPROVE ?? "yes";

const nc = await connect(parseNatsUrl(NATS_URL));
const agents = new Agents({ nc });
try {
  // Wait for the agent to show up in discovery (tolerates starting serve + caller together).
  let agent: Awaited<ReturnType<typeof agents.discover>>[number] | undefined;
  for (let i = 0; i < 20 && !agent; i++) {
    const found = await agents.discover();
    agent = found.find((a) => a.agent === "durable-sre") ?? found[0];
    if (!agent) await new Promise((r) => setTimeout(r, 500));
  }
  if (!agent) {
    console.error("no durable-sre agent found — is `bun run src/sre/serve.ts` running?");
    process.exit(2);
  }
  console.log(`prompting ${agent.agent}/${agent.owner}/${agent.name}:\n  "${PROMPT}"\n`);

  for await (const msg of await agent.prompt(PROMPT)) {
    switch (msg.type) {
      case "status":
        console.log(`  [status] ${(msg as { status?: string }).status ?? ""}`);
        break;
      case "query":
        console.log(`  [query]  ${msg.prompt}\n           → replying "${APPROVE}"`);
        await msg.reply(APPROVE);
        break;
      case "response":
        process.stdout.write(`  [answer] ${msg.text}`);
        break;
    }
  }
  console.log("\n\n✅ prompt complete");
} finally {
  await agents.close();
  await nc.close();
  process.exit(0);
}

// caller.ts — a tiny client that prompts the durable SRE agent and auto-answers the approval query.
// Doubles as the end-to-end verification driver and a demo entrypoint.
//   bun run src/caller.ts "checkout is slow — investigate and fix."
//   APPROVE=no bun run src/caller.ts     # deny the restart instead
import { Agents } from "@synadia-ai/agents";
import { closeExampleNats, connectExampleNats } from "./core/nats";

const PROMPT = process.argv.slice(2).join(" ") || "checkout is slow — investigate and fix.";
const APPROVE = process.env.APPROVE ?? "yes";
const AGENT = process.env.AGENT ?? "durable-sre"; // e.g. AGENT=durable-coder to reach the coding agent

const connection = await connectExampleNats("durable-agent-caller");
const { nc, bundle } = connection;
let agents: Agents;
try {
  agents = new Agents({
    nc,
    ...(bundle.signer ? { identity: { signer: bundle.signer, name: "durable-agent-caller" } } : {}),
  });
} catch (error) {
  await closeExampleNats(connection);
  throw error;
}
try {
  // Wait for the agent to show up in discovery (tolerates starting serve + caller together).
  let agent: Awaited<ReturnType<typeof agents.discover>>[number] | undefined;
  for (let i = 0; i < 20 && !agent; i++) {
    const found = await agents.discover();
    agent = found.find((a) => a.agent === AGENT) ?? found[0];
    if (!agent) await new Promise((r) => setTimeout(r, 500));
  }
  if (!agent) {
    console.error(`no "${AGENT}" agent found — is the matching serve process running?`);
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
  try {
    await agents.close();
  } finally {
    await closeExampleNats(connection);
  }
  process.exit(0);
}

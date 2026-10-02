// Tiny driver: discover the research agent and stream a prompt to it.
import process, { stdout } from "node:process";
import { Agents } from "@synadia-ai/agents";
import { connectResearchNats } from "../src/nats.js";

const question =
  process.argv.slice(2).join(" ") ||
  "what are the main tradeoffs between DSPy ReAct and DSPy RLM?";

const { nc, bundle: connectionBundle } = await connectResearchNats("dspy-research-caller");
let agents: Agents;
try {
  agents = new Agents({
    nc,
    ...(connectionBundle.signer
      ? { identity: { signer: connectionBundle.signer, name: "dspy-research-caller" } }
      : {}),
  });
} catch (error) {
  await nc.close();
  connectionBundle.wipe();
  throw error;
}

try {
  const found = await agents.discover();
  const target = found.find((a) => a.agent === "research");
  if (!target) {
    console.error("no research agent found — start it first: bun run src/index.ts");
    process.exit(2);
  }
  console.error(`> asking ${target.agent}/${target.owner}/${target.name}: ${question}\n`);
  for await (const msg of await target.prompt(question, { inactivityTimeoutMs: 300_000 })) {
    switch (msg.type) {
      case "status":
        process.stderr.write(`  [status] ${msg.status}\n`);
        break;
      case "response":
        stdout.write(msg.text);
        break;
      default:
        // The RLM agent doesn't emit `query` chunks today, but a future version
        // might ask for clarification — this CLI can't answer, so surface it
        // instead of silently hanging until the inactivity timeout.
        process.stderr.write(`  [warn] ignoring unsupported "${msg.type}" chunk\n`);
        break;
    }
  }
  stdout.write("\n");
} finally {
  try {
    await agents.close();
  } finally {
    await nc.close();
    connectionBundle.wipe();
  }
}

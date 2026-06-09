// Tiny driver: discover the research agent and stream a prompt to it.
import process, { stdout } from "node:process";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const question =
  process.argv.slice(2).join(" ") ||
  "what are the main tradeoffs between DSPy ReAct and DSPy RLM?";

const nc = await natsConnect({
  servers: process.env["NATS_URL"] ?? "nats://127.0.0.1:4222",
});
const agents = new Agents({ nc });

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
  await agents.close();
  await nc.close();
}

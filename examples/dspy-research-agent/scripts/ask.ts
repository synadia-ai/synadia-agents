// Tiny driver: discover the research agent and stream a prompt to it.
import process, { stdout } from "node:process";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, loadContextOptions, parseNatsUrl } from "@synadia-ai/agents";

const question =
  process.argv.slice(2).join(" ") ||
  "what are the main tradeoffs between DSPy ReAct and DSPy RLM?";

// NATS_CONTEXT (a named CLI context) wins, then NATS_URL, then localhost —
// same resolution as the agent in src/index.ts.
const opts = process.env["NATS_CONTEXT"]
  ? await loadContextOptions(process.env["NATS_CONTEXT"])
  : process.env["NATS_URL"]
    ? parseNatsUrl(process.env["NATS_URL"])
    : { servers: "nats://127.0.0.1:4222" };
const nc = await natsConnect(opts);
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

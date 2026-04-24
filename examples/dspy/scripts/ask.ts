// Tiny driver: discover the dspy agent and stream a prompt to it.
import process from "node:process";
import { stdout } from "node:process";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const question = process.argv.slice(2).join(" ") || "list the sandbox contents and summarize what you find";

const nc = await natsConnect({
  servers: process.env["NATS_URL"] ?? "nats://127.0.0.1:4222",
});
const agents = new Agents({ nc });

try {
  const found = await agents.discover();
  const target = found.find((a) => a.agent === "dspy");
  if (!target) {
    console.error("no dspy agent found — start it first: bun run src/index.ts");
    process.exit(2);
  }
  console.error(`> asking ${target.agent}/${target.owner}/${target.name}: ${question}\n`);
  for await (const msg of await target.prompt(question, { inactivityTimeoutMs: 120_000 })) {
    switch (msg.type) {
      case "status":
        process.stderr.write(`  [status] ${msg.status}\n`);
        break;
      case "response":
        stdout.write(msg.text);
        break;
    }
  }
  stdout.write("\n");
} finally {
  await agents.close();
  await nc.close();
}

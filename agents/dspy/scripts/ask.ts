// Tiny driver: discover the dspy agent and stream a prompt to it.
import process from "node:process";
import { stdout } from "node:process";
import { connect } from "@synadia/agents";

const question = process.argv.slice(2).join(" ") || "list the sandbox contents and summarize what you find";

const client = await connect({
  name: "dspy-ask",
  servers: process.env["NATS_URL"] ?? "nats://127.0.0.1:4222",
});

try {
  const agents = await client.discover({ timeoutMs: 2_000 });
  const target = agents.find((a) => a.agent === "dspy");
  if (!target) {
    console.error("no dspy agent found — start it first: bun run src/index.ts");
    process.exit(2);
  }
  console.error(`> asking ${target.agent}/${target.owner}/${target.name}: ${question}\n`);
  const remote = client.bind(target);
  for await (const msg of await remote.prompt(question, { inactivityTimeoutMs: 120_000 })) {
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
  await client.close();
}

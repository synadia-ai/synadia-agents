// Demonstrates mid-stream query handling. The agent pauses its response
// to ask a clarifying question; the caller answers; the agent continues.
// Run a query-capable agent of your own — the reference agent's default
// handler doesn't emit queries.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents, type QueryEvent } from "@synadia-ai/agents";

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(`${prompt} `);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const text = process.argv[2] ?? "plan the migration";
  const nc = await natsConnect({
    servers: process.env["NATS_URL"] ?? "nats://127.0.0.1:4222",
  });
  const agents = new Agents({ nc });
  try {
    const [agent] = await agents.discover();
    if (!agent) {
      console.error("no agents found.");
      process.exit(2);
    }

    for await (const msg of await agent.prompt(text)) {
      switch (msg.type) {
        case "response":
          stdout.write(msg.text);
          break;
        case "query":
          await handleQuery(msg);
          break;
        case "status":
          if (msg.status === "done") stdout.write("\n[done]\n");
          break;
      }
    }
  } finally {
    await agents.close();
    await nc.close();
  }
}

async function handleQuery(q: QueryEvent): Promise<void> {
  stdout.write(`\n[agent asks: ${q.prompt}]\n`);
  const answer = await ask(">");
  await q.reply(answer);
}

void main().catch((err: unknown) => {
  console.error("query demo failed:", err);
  process.exit(1);
});

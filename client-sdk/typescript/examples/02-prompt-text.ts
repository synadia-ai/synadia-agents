// Minimal prompt example — pick the first discovered agent, stream the
// response text to stdout, exit on the terminator.

import { stdout } from "node:process";
import { openExampleAgents } from "./_connection";

async function main(): Promise<void> {
  const text = process.argv[2] ?? "hello";
  const connection = await openExampleAgents();
  const { agents } = connection;
  try {
    const [agent] = await agents.discover();
    if (!agent) {
      console.error("no agents found — start the reference agent first.");
      process.exitCode = 2;
      return;
    }
    for await (const msg of await agent.prompt(text)) {
      switch (msg.type) {
        case "response":
          stdout.write(msg.text);
          break;
        case "status":
          if (msg.status === "done") stdout.write("\n");
          break;
      }
    }
  } finally {
    await connection.close();
  }
}

void main().catch((err: unknown) => {
  console.error("prompt failed:", err);
  process.exit(1);
});

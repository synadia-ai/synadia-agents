// Minimal prompt example — pick the first discovered agent, stream the
// response text to stdout, exit on the terminator.

import { stdout } from "node:process";
import { connect } from "@synadia/agents";

async function main(): Promise<void> {
  const text = process.argv[2] ?? "hello";
  const client = await connect({
    name: "text-demo",
    servers: process.env["NATS_URL"] ?? "nats://127.0.0.1:4222",
  });
  try {
    const [agent] = await client.discover({ timeoutMs: 2_000 });
    if (!agent) {
      console.error("no agents found — start the reference agent first.");
      process.exit(2);
    }
    const remote = client.bind(agent);
    for await (const msg of await remote.prompt(text)) {
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
    await client.close();
  }
}

void main().catch((err: unknown) => {
  console.error("prompt failed:", err);
  process.exit(1);
});

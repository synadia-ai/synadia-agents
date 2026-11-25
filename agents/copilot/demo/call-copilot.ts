// Prompt a Copilot session that joined the fleet via the synadia-nats
// extension, streaming its reply, status updates and permission queries.
//
//   NATS_URL=nats://127.0.0.1:4222 bun demo/call-copilot.ts "What files are in this folder?"
//
// Picks the first discovered agent whose type is "copilot" unless
// COPILOT_SUBJECT names an exact prompt subject.
import { createInterface } from "node:readline/promises";

import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const servers = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const text = process.argv.slice(2).join(" ") || "Say hello to the NATS fleet in one short sentence.";

const nc = await connect({ servers });
const agents = new Agents({ nc });
const found = await agents.discover({ timeoutMs: 2000 });
const target = process.env.COPILOT_SUBJECT
  ? found.find((a) => a.promptSubject === process.env.COPILOT_SUBJECT)
  : found.find((a) => a.promptSubject.startsWith("agents.prompt.copilot."));
if (!target) {
  console.error(`no copilot agent found; saw: ${found.map((a) => a.promptSubject).join(", ") || "(none)"}`);
  await nc.close();
  process.exit(1);
}
console.error(`[caller] prompting ${target.promptSubject}`);

const rl = createInterface({ input: process.stdin, output: process.stderr });
try {
  for await (const msg of await target.prompt(text)) {
    if (msg.type === "response") process.stdout.write(msg.text);
    else if (msg.type === "status") console.error(`\n[status] ${msg.status}`);
    else if (msg.type === "query") {
      const answer = process.env.AUTO_ANSWER ?? (await rl.question(`\n[query] ${msg.prompt}\n> `));
      await msg.reply(answer);
    }
  }
  process.stdout.write("\n");
} finally {
  rl.close();
  await nc.close();
}

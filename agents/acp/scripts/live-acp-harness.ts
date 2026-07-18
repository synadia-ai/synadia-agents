#!/usr/bin/env bun
// Manual live-validation harness: discover a running acp-agent channel on
// NATS, send one prompt, stream the reply, and auto-answer §7 permission
// queries. Requires a real channel (e.g. managed grok) already running —
// this script starts nothing itself.
//
// Usage:
//   NATS_URL=nats://127.0.0.1:4222 bun scripts/live-acp-harness.ts \
//     --agent grok --session live-test --answer approve "your prompt here"
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const args = process.argv.slice(2);
let agentId = "grok";
let session: string | undefined;
let answer = "approve";
const rest: string[] = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]!;
  if (arg === "--agent") agentId = args[++i] ?? agentId;
  else if (arg === "--session") session = args[++i];
  else if (arg === "--answer") answer = args[++i] ?? answer;
  else rest.push(arg);
}
const prompt = rest.join(" ").trim();
if (!prompt) {
  console.error("usage: live-acp-harness.ts [--agent id] [--session name] [--answer approve|deny] <prompt>");
  process.exit(1);
}

const nc = await natsConnect({ servers: process.env.NATS_URL ?? "nats://127.0.0.1:4222" });
const agents = new Agents({ nc });
const found = await agents.discover({
  timeoutMs: 2000,
  filter: { agent: agentId, ...(session !== undefined ? { name: session } : {}) },
});
if (found.length === 0) throw new Error(`no ${agentId} agent found on the bus`);
const agent = found[0]!;
console.error(`[harness] prompting ${agent.promptEndpoint.subject}`);

const events: Array<Record<string, unknown>> = [];
let responseText = "";
for await (const msg of await agent.prompt(prompt, { inactivityTimeoutMs: 180_000 })) {
  if (msg.type === "response") {
    responseText += msg.text;
    process.stderr.write(msg.text);
    events.push({ type: "response", bytes: msg.text.length });
  } else if (msg.type === "status") {
    console.error(`\n[status] ${msg.status}`);
    events.push({ type: "status", status: msg.status });
  } else if (msg.type === "query") {
    console.error(`\n[query] ${msg.prompt}\n[query] auto-answering: ${answer}`);
    events.push({ type: "query", prompt: msg.prompt.slice(0, 200), answered: answer });
    await msg.reply(answer);
  }
}

console.error("\n[harness] stream complete");
console.log(JSON.stringify({ subject: agent.promptEndpoint.subject, events, responseText }, null, 2));
await agents.close();
await nc.close();

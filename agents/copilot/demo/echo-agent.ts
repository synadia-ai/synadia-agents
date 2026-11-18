// A tiny fleet agent for demos: answers every prompt with a fixed, easily
// recognisable reply so you can see Copilot's outbound tools reach it.
//
//   NATS_URL=nats://127.0.0.1:4222 bun demo/echo-agent.ts
import { connect } from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agent-service";

const servers = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const nc = await connect({ servers });
const service = new AgentService({
  nc,
  agent: "echo",
  owner: process.env.DEMO_OWNER ?? "demo",
  name: process.env.DEMO_NAME ?? "guest",
  description: "Demo echo agent: echoes your prompt and its words in reverse order.",
});
service.onPrompt(async (envelope, response) => {
  const reversed = envelope.prompt.split(/\s+/).reverse().join(" ");
  console.log(`[echo-agent] prompt: ${JSON.stringify(envelope.prompt)}`);
  await response.send(`echo-agent says: ${envelope.prompt} | reversed: ${reversed}`);
});
await service.start();
console.log(`[echo-agent] listening on ${service.subject.prompt} via ${servers}`);

const shutdown = async () => {
  await service.stop().catch(() => {});
  await nc.drain().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Minimal echo agent — replies to every prompt with `echo: <prompt text>`.
//
// The shortest runnable demonstration of the `AgentService` host API.
// Use this as a smoke target while iterating on a caller, or as a
// starting shape when writing your own agent.
//
// Connection resolution:
//   1. $NATS_CONTEXT — name of a NATS CLI context under ~/.config/nats/context/
//   2. $NATS_URL     — raw URL (credentials in userinfo are honored)
//   3. nats://127.0.0.1:4222

import { connect as natsConnect } from "@nats-io/transport-node";
import { loadContextOptions, parseNatsUrl } from "@synadia-ai/agents";
import { AgentService } from "@synadia-ai/agent-service";

async function main(): Promise<void> {
  const opts = process.env["NATS_CONTEXT"]
    ? await loadContextOptions(process.env["NATS_CONTEXT"])
    : process.env["NATS_URL"]
      ? parseNatsUrl(process.env["NATS_URL"])
      : { servers: "nats://127.0.0.1:4222" };
  const nc = await natsConnect(opts);

  const service = new AgentService({
    nc,
    agent: "echo",
    owner: process.env["USER"] ?? "anon",
    name: "main",
    description: "Echo agent — replies with the prompt prefixed by 'echo: '",
  });

  service.onPrompt(async (envelope, response) => {
    await response.send(`echo: ${envelope.prompt}`);
  });

  await service.start();
  console.log(`echo agent listening on ${service.subject.prompt}`);
  console.log("press Ctrl+C to stop");

  const shutdown = async (): Promise<void> => {
    console.log("\nshutting down…");
    await service.stop();
    await nc.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((err: unknown) => {
  console.error("echo agent failed:", err);
  process.exit(1);
});

// Spin up a spec-compliant reference agent for local experimentation.
// Companion to the `examples/*` scripts — run this in one terminal, then
// invoke the demos in another.

import type { ServiceMsg } from "@nats-io/services";
import { connect as natsConnect } from "@nats-io/transport-node";
import { ReferenceAgent } from "@synadia-ai/agent-service/testing";

async function main(): Promise<void> {
  const nc = await natsConnect({ servers: process.env["NATS_URL"] ?? "nats://127.0.0.1:4222" });

  const agent = new ReferenceAgent({
    nc,
    agent: "demo-agent",
    owner: process.env["USER"] ?? "anon",
    name: "example",
    description: "reference agent for @synadia-ai/agents examples",
    maxPayload: "1MB",
    attachmentsOk: true,
    heartbeatIntervalS: 5,
    promptHandler: (msg: ServiceMsg) => {
      // Echo a tiny acknowledgement. Real agents produce actual inference.
      msg.respond(
        new TextEncoder().encode(
          JSON.stringify({ type: "response", data: "demo agent received your prompt." }),
        ),
      );
      msg.respond(""); // terminator
    },
  });
  await agent.start();
  console.log(`reference agent listening on ${agent.promptSubject}`);
  console.log("press Ctrl+C to stop");

  const shutdown = async (): Promise<void> => {
    console.log("\nshutting down…");
    await agent.stop();
    await nc.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((err: unknown) => {
  console.error("reference agent failed:", err);
  process.exit(1);
});

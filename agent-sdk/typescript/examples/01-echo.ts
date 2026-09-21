// Minimal echo agent — replies to every prompt with `echo: <prompt text>`.
//
// The shortest runnable demonstration of the `AgentService` host API.
// Use this as a smoke target while iterating on a caller, or as a
// starting shape when writing your own agent.
//
// Shared connection resolution (`_connection.ts`): $NATS_CONTEXT wins as one
// complete source; otherwise $NATS_URL combines with NATS_NKEY_SEED_FILE or
// NATS_CREDS, then falls back to localhost. NATS_SENDER_IDENTITY=signed derives
// registration identity from that same source; identity is off by default.

import { AgentService } from "@synadia-ai/agent-service";
import { openExampleNatsConnection, waitForTermination } from "./_connection";

async function main(): Promise<void> {
  const connection = await openExampleNatsConnection();
  let service: AgentService | undefined;

  try {
    // Identity → subject `agents.prompt.echo.<owner>.<name>`. Owner and name are
    // env-overridable so several people can run this against one server without
    // colliding; `agent` ("echo") is what this example *is*, so it stays fixed.
    const heartbeatIntervalS = Number(process.env["NATS_AGENT_HEARTBEAT_INTERVAL"]) || undefined;
    service = new AgentService({
      nc: connection.nc,
      agent: "echo",
      owner:
        process.env["SYNADIA_ECHO_OWNER"] ??
        process.env["SYNADIA_OWNER"] ??
        process.env["NATS_AGENT_OWNER"] ??
        process.env["USER"] ??
        "anon",
      name:
        process.env["SYNADIA_ECHO_NAME"] ??
        process.env["SYNADIA_NAME"] ??
        process.env["NATS_AGENT_NAME"] ??
        "main",
      ...(heartbeatIntervalS !== undefined ? { heartbeatIntervalS } : {}),
      ...(connection.signer ? { identity: { signer: connection.signer } } : {}),
      description: "Echo agent — replies with the prompt prefixed by 'echo: '",
    });

    service.onPrompt(async (envelope, response) => {
      await response.send(`echo: ${envelope.prompt}`);
    });

    await service.start();
    console.log(`echo agent listening on ${service.subject.prompt}`);
    console.log("press Ctrl+C to stop");
    await waitForTermination();
    console.log("\nshutting down…");
  } finally {
    try {
      await service?.stop();
    } finally {
      await connection.close();
    }
  }
}

void main().catch((err: unknown) => {
  console.error("echo agent failed:", err);
  process.exit(1);
});

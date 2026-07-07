// sre/serve.ts — the REAL showcase: the SRE agent running on live infrastructure.
//
//   caller ──prompt──▶ AgentService front-door ──beginRun──▶ Resonate worker (this process)
//                              │                                   │
//                              │  approval as §7 query             │ durable steps journaled to
//                              ▼                                   ▼ resonate-on-nats over NATS
//                         the human answers                   JetStream (survives a crash)
//
// One process is both the durable worker (registers "sre-agent") and the front-door. Kill it
// mid-run and restart it in the same group → the run resumes from the journal (see crash-replay).
//
// Prereqs (see README): a nats-server, `resonate-on-nats serve`, and — for a real brain —
//   LLM_BACKEND=ollama OLLAMA_MODEL=gpt-oss:latest   (otherwise a deterministic stub runs).
// Run:  bun run src/sre/serve.ts
import { connect } from "@nats-io/transport-node";
import { type Context, NatsNetwork, Resonate } from "@resonatehq/sdk";
import { parseNatsUrl } from "@synadia-ai/agents";
import { agentLoop } from "../core/effects";
import { serveAgent } from "../core/frontdoor";
import { createLlm } from "../core/llm";
import { driveResonate, type Notify } from "../core/resonate";
import { approvalSubject } from "../core/subjects";
import { sreStub, sreSystem, sreTools } from "./agent";

const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const GROUP = process.env.RESONATE_GROUP ?? "sre-workers";
const OWNER = process.env.USER ?? "anon";

const nc = await connect(parseNatsUrl(NATS_URL));
const resonate = new Resonate({ network: new NatsNetwork({ conn: nc, group: GROUP }) });

// Stub by default (offline-deterministic); set LLM_BACKEND=ollama OLLAMA_MODEL=gpt-oss:latest for the real brain.
const llm = createLlm({ stub: sreStub });
console.log(`brain: ${llm.label}`);

// The durable workflow: the engine-neutral agent loop driven on Resonate. Announces parked
// approvals on a per-run subject so the front-door can raise an in-chat query.
resonate.register("sre-agent", function* (ctx: Context, input: { prompt: string }) {
  const notify: Notify = async (awaitName, promiseId, ask) => {
    nc.publish(approvalSubject(ctx.id), JSON.stringify({ awaitName, promiseId, ask }));
    await nc.flush();
  };
  return yield* driveResonate(
    ctx,
    agentLoop({ llm, system: sreSystem, prompt: input.prompt, tools: sreTools() }),
    notify,
  );
});

const service = await serveAgent({
  nc,
  resonate,
  workflowName: "sre-agent",
  agent: "durable-sre",
  owner: OWNER,
  name: "sre",
  description: "Durable SRE agent (Resonate over NATS): metrics → restart-with-approval → notify. Survives crashes.",
});

console.log(`durable SRE agent listening on: ${service.subject.prompt}`);
console.log(`workers group: ${GROUP}   |   NATS: ${NATS_URL}`);
console.log("press Ctrl+C to stop");

const shutdown = async (): Promise<void> => {
  console.log("\nshutting down…");
  await service.stop();
  await resonate.stop();
  await nc.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

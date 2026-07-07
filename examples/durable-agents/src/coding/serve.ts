// coding/serve.ts — the "durable Claude Code" agent on live infrastructure. Same shape as the SRE
// serve entry, a different tool-set: sandboxed fs tools + an approval-gated run_bash. One process is
// both the durable worker (registers "coding-agent") and the AgentService front-door; kill it
// mid-task and restart it in the same group → the run resumes from the journal.
//
// Prereqs: nats-server + `resonate-on-nats serve`. For a real brain:
//   LLM_BACKEND=ollama OLLAMA_MODEL=qwen3.6:35b-mlx   (or gpt-oss:latest)
// Run:  bun run src/coding/serve.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { connect } from "@nats-io/transport-node";
import { type Context, NatsNetwork, Resonate } from "@resonatehq/sdk";
import { parseNatsUrl } from "@synadia-ai/agents";
import { agentLoop } from "../core/effects";
import { serveAgent } from "../core/frontdoor";
import { createLlm } from "../core/llm";
import { driveResonate, type Notify } from "../core/resonate";
import { approvalSubject } from "../core/subjects";
import { codingStub, codingSystem, codingTools } from "./agent";

const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const GROUP = process.env.RESONATE_GROUP ?? "coder-workers";
const OWNER = process.env.USER ?? "anon";
const SANDBOX = path.resolve(process.env.CODING_SANDBOX ?? "./coding-sandbox");

await fs.mkdir(SANDBOX, { recursive: true });
const nc = await connect(parseNatsUrl(NATS_URL));
const resonate = new Resonate({ network: new NatsNetwork({ conn: nc, group: GROUP }) });

const llm = createLlm({ stub: codingStub });
console.log(`brain: ${llm.label}   sandbox: ${SANDBOX}`);

resonate.register("coding-agent", function* (ctx: Context, input: { prompt: string }) {
  const notify: Notify = async (awaitName, promiseId, ask) => {
    nc.publish(approvalSubject(ctx.id), JSON.stringify({ awaitName, promiseId, ask }));
    await nc.flush();
  };
  return yield* driveResonate(
    ctx,
    agentLoop({ llm, system: codingSystem, prompt: input.prompt, tools: codingTools(SANDBOX) }),
    notify,
  );
});

const service = await serveAgent({
  nc,
  resonate,
  workflowName: "coding-agent",
  agent: "durable-coder",
  owner: OWNER,
  name: "coder",
  description: "Durable coding agent (Resonate over NATS): sandboxed read/write/grep + run_bash with approval. Survives crashes.",
});

console.log(`durable coding agent listening on: ${service.subject.prompt}`);
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

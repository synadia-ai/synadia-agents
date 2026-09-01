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
import { type Context, NatsNetwork, Resonate } from "@resonatehq/sdk";
import { agentLoop } from "../core/effects";
import { serveAgent } from "../core/frontdoor";
import { createLlm } from "../core/llm";
import { closeExampleNats, connectExampleNats, minSenderTrust, natsTargetDescription } from "../core/nats";
import { driveResonate, type Notify } from "../core/resonate";
import { approvalSubject } from "../core/subjects";
import { codingStub, codingSystem, codingTools } from "./agent";

const GROUP = process.env.RESONATE_GROUP ?? "coder-workers";
const OWNER = process.env.USER ?? "anon";
const SANDBOX = path.resolve(process.env.CODING_SANDBOX ?? "./coding-sandbox");

await fs.mkdir(SANDBOX, { recursive: true });
const connection = await connectExampleNats("durable-coder");
const { nc, bundle } = connection;
let resonate: Resonate;
let service: Awaited<ReturnType<typeof serveAgent>>;
try {
  resonate = new Resonate({ network: new NatsNetwork({ conn: nc, group: GROUP }) });

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

  service = await serveAgent({
    nc,
    connectionBundle: bundle,
    minSenderTrust: minSenderTrust(),
    resonate,
    workflowName: "coding-agent",
    agent: "durable-coder",
    owner: OWNER,
    name: "coder",
    description: "Durable coding agent (Resonate over NATS): sandboxed read/write/grep + run_bash with approval. Survives crashes.",
  });
} catch (error) {
  await closeExampleNats(connection);
  throw error;
}

console.log(`durable coding agent listening on: ${service.subject.prompt}`);
console.log(`workers group: ${GROUP}   |   NATS: ${natsTargetDescription()}`);
console.log("press Ctrl+C to stop");

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nshutting down…");
  let exitCode = 0;
  try {
    await service.stop();
  } catch (error) {
    exitCode = 1;
    console.error(`durable coding service stop failed: ${(error as Error).message}`);
  }
  try {
    await resonate.stop();
  } catch (error) {
    exitCode = 1;
    console.error(`durable coding worker stop failed: ${(error as Error).message}`);
  }
  await closeExampleNats(connection);
  process.exit(exitCode);
};
const requestShutdown = (): void => {
  void shutdown().catch((error: unknown) => {
    shuttingDown = false;
    console.error(`durable coding agent shutdown failed: ${(error as Error).message}`);
  });
};
process.on("SIGINT", requestShutdown);
process.on("SIGTERM", requestShutdown);

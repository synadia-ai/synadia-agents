// src/crash/worker.ts — a headless durable SRE worker for the crash-replay proof.
//
// PHASE=1: dispatch the run and, the instant get_metrics's result is journaled, HARD-crash
//          (process.exit) — a worker death mid-task.
// PHASE=2: rejoin the same group. The server's lease expires and it re-dispatches the orphaned run,
//          which REPLAYS from the JetStream journal (recorded steps return without re-executing) and
//          finishes.
//
// Every REAL model/tool execution is appended to EXEC_LOG, so demo.ts can prove which steps ran in
// which phase (i.e. that pre-crash work was replayed, not re-run). Uses the deterministic stub so
// the crash point and the proof are reproducible.
import { appendFileSync } from "node:fs";
import { connect } from "@nats-io/transport-node";
import { Codec, type Context, NatsNetwork, Resonate } from "@resonatehq/sdk";
import { parseNatsUrl } from "@synadia-ai/agents";
import { agentLoop } from "../core/effects";
import { createLlm, type LlmClient } from "../core/llm";
import { driveResonate, type Notify } from "../core/resonate";
import { sreStub, sreSystem, sreTools } from "../sre/agent";

const PHASE = process.env.PHASE ?? "1";
const RUN_ID = process.env.RUN_ID ?? "sre-crash-1";
const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const EXEC_LOG = process.env.EXEC_LOG ?? "/tmp/de-crash-exec.jsonl";
const GROUP = "sre-crash";
const approvalSubject = (runId: string): string => `de-agent.approval.${runId}`; // same as the front-door

const logExec = (kind: string, name: string): void =>
  appendFileSync(EXEC_LOG, `${JSON.stringify({ phase: PHASE, kind, name })}\n`);

// Wrap the deterministic stub so each REAL model call is recorded (a replayed turn is NOT recorded).
const base = createLlm({ stub: sreStub });
const llm: LlmClient = {
  label: base.label,
  decide: async (m, t) => {
    logExec("llm", "decide");
    return base.decide(m, t);
  },
};

const nc = await connect(parseNatsUrl(NATS_URL));
const codec = new Codec();
// Short lease (ttl) so a crashed worker's run is re-dispatched quickly instead of after the default minute.
const resonate = new Resonate({ network: new NatsNetwork({ conn: nc, group: GROUP }), ttl: 5000 });

// Headless auto-approver (no human in this proof): resolve any parked approval for our run.
nc.subscribe(approvalSubject(RUN_ID), {
  callback: (err, msg) => {
    if (err) return;
    const { promiseId } = JSON.parse(msg.string()) as { promiseId: string };
    void resonate.promises.resolve(promiseId, codec.encode({ approved: true }));
    console.log(`[phase ${PHASE}] auto-approved restart`);
  },
});

resonate.register("sre-agent", function* (ctx: Context, input: { prompt: string }) {
  const notify: Notify = async (awaitName, promiseId, ask) => {
    nc.publish(approvalSubject(ctx.id), JSON.stringify({ awaitName, promiseId, ask }));
    await nc.flush();
  };
  return yield* driveResonate(
    ctx,
    agentLoop({ llm, system: sreSystem, prompt: input.prompt, tools: sreTools((name) => logExec("tool", name)) }),
    notify,
    {
      afterStep: (name) => {
        // Phase 1: crash the instant get_metrics (tool-0-0) is journaled — a clean mid-run death.
        if (PHASE === "1" && name === "tool-0-0") {
          console.log(`[phase 1] 💥 crashing right after ${name} (already journaled) — simulating worker death`);
          process.exit(137);
        }
      },
    },
  );
});

console.log(`[phase ${PHASE}] worker up (group ${GROUP}, run ${RUN_ID}, lease 5s)`);
const handle = await resonate.beginRun(RUN_ID, "sre-agent", { prompt: "checkout is slow — investigate and fix." });
console.log(`[phase ${PHASE}] awaiting result…`);
const result = await handle.result();
console.log(`[phase ${PHASE}] ✅ completed: ${JSON.stringify(result)}`);
await resonate.stop();
await nc.close();
process.exit(0);

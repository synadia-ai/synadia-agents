// coding/index.ts — OFFLINE smoke of the coding agent's durable brain (in-memory Resonate, stub,
// auto-approval, a throwaway sandbox). No infrastructure; proves the loop + the fs/bash tools + the
// run_bash approval gate. The real showcase — NATS, a real model, crash-replay — is serve.ts.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Codec, type Context, Resonate } from "@resonatehq/sdk";
import { agentLoop, type AgentResult } from "../core/effects";
import { createLlm } from "../core/llm";
import { driveResonate, type Notify } from "../core/resonate";
import { codingStub, codingSystem, codingTools } from "./agent";

const SANDBOX = await fs.mkdtemp(path.join(tmpdir(), "de-coder-"));
const calls: Record<string, number> = {};
const tools = codingTools(SANDBOX, (name, _args, key) => {
  calls[name] = (calls[name] ?? 0) + 1;
  console.log(`   · ${name}  [key=${key}]`);
});

const codec = new Codec();
const resonate = new Resonate();
const inbox: Array<{ promiseId: string; ask: unknown }> = [];
const notify: Notify = (_name, promiseId, ask) => {
  inbox.push({ promiseId, ask });
};

resonate.register("coding-agent", function* (ctx: Context) {
  return yield* driveResonate(
    ctx,
    agentLoop({ llm: createLlm({ stub: codingStub }), system: codingSystem, prompt: "create a greeting file, read it back, and measure it", tools }),
    notify,
  );
});

console.log(`▶ coding agent (durable brain, offline; sandbox ${SANDBOX}):`);
const handle = await resonate.beginRun("coder-offline-1", "coding-agent");

const approver = setInterval(() => {
  while (inbox.length) {
    const { promiseId, ask } = inbox.shift()!;
    console.log(`   🔔 approval requested: ${JSON.stringify(ask)} → approving`);
    void resonate.promises.resolve(promiseId, codec.encode({ approved: true }));
  }
}, 5);

const result = (await handle.result()) as AgentResult;
clearInterval(approver);
await resonate.stop();

console.log(`\n🧠 answer: ${result.answer}`);
console.log(`   tool executions: ${JSON.stringify(calls)}`);
const ok = calls.write_file === 1 && calls.read_file === 1 && calls.run_bash === 1;
console.log(ok ? "✅ tools executed as scripted (write, read, approval-gated bash)" : "❌ unexpected tool counts");
await fs.rm(SANDBOX, { recursive: true, force: true });
process.exit(ok ? 0 : 1);

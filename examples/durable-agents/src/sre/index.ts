// sre/index.ts — OFFLINE smoke of the SRE agent's durable brain (Resonate's in-memory server,
// a deterministic stub, auto-approval). No infrastructure; proves the loop + exactly-once effects
// and doubles as a fast test. The real showcase — NATS, gpt-oss, live crash-replay — is serve.ts.
import { Codec, type Context, Resonate } from "@resonatehq/sdk";
import { agentLoop, type AgentResult } from "../core/effects";
import { createLlm } from "../core/llm";
import { driveResonate, type Notify } from "../core/resonate";
import { sreStub, sreSystem, sreTools } from "./agent";

const calls: Record<string, number> = {};
const tools = sreTools((name, _args, key) => {
  calls[name] = (calls[name] ?? 0) + 1;
  console.log(`   · ${name}  [key=${key}]`);
});

const codec = new Codec();
const resonate = new Resonate(); // no url ⇒ in-memory (no NATS needed for this smoke run)

const inbox: Array<{ promiseId: string; ask: unknown }> = [];
const notify: Notify = (_name, promiseId, ask) => {
  inbox.push({ promiseId, ask });
};

resonate.register("sre-agent", function* (ctx: Context) {
  return yield* driveResonate(
    ctx,
    agentLoop({ llm: createLlm({ stub: sreStub }), system: sreSystem, prompt: "checkout is slow — investigate and fix.", tools }),
    notify,
  );
});

console.log("▶ SRE agent (durable brain, offline in-memory Resonate):");
const handle = await resonate.beginRun("sre-offline-1", "sre-agent");

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
const ok = calls.get_metrics === 1 && calls.restart_service === 1 && calls.send_notification === 1;
console.log(ok ? "✅ every tool executed exactly once" : "❌ tool-exec count wrong");
process.exit(ok ? 0 : 1);

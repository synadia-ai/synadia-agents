// src/crash/demo.ts — orchestrate and VERIFY the crash-replay proof (the headline).
//
// Spawns a worker, lets it run the agent and crash right after get_metrics, then spawns a fresh
// worker that resumes the SAME run from the journal. Finally it reads the persisted execution log
// and proves the pre-crash work was replayed (not re-executed): the model is billed 4× total across
// the crash — not 5×+ — and every side-effecting tool fires exactly once.
//
// Prereqs: nats-server + `resonate-on-nats serve` running (see README).  Run: bun run src/crash/demo.ts
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXEC_LOG = join(tmpdir(), "de-crash-exec.jsonl");
const RUN_ID = `sre-crash-${Date.now()}`; // dotless: a dot would denote lineage in Resonate
const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
if (existsSync(EXEC_LOG)) rmSync(EXEC_LOG);

type Exec = { phase: string; kind: string; name: string };
const readLog = (): Exec[] =>
  existsSync(EXEC_LOG)
    ? readFileSync(EXEC_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Exec)
    : [];

const runWorker = (phase: string): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn("bun", ["run", "src/crash/worker.ts"], {
      env: { ...process.env, PHASE: phase, RUN_ID, EXEC_LOG, NATS_URL },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });

console.log("═══ PHASE 1 — run the durable agent, crash it right after get_metrics ═══");
const code1 = await runWorker("1");
console.log(`(phase 1 worker exited code ${code1} — a simulated crash)\n`);

console.log("═══ PHASE 2 — restart the worker; the run RESUMES from the JetStream journal ═══");
console.log("(waiting for the lease to expire so the server re-dispatches the orphaned run…)\n");
const code2 = await runWorker("2");
console.log(`\n(phase 2 worker exited code ${code2})`);

const log = readLog();
const llmCalls = log.filter((e) => e.kind === "llm").length;
const n = (name: string): number => log.filter((e) => e.name === name).length;
const stepsIn = (phase: string): string => log.filter((e) => e.phase === phase).map((e) => e.name).join(", ") || "(none)";

console.log("\n═══════════════ VERDICT ═══════════════");
console.log(`phase 1 executed:  ${stepsIn("1")}`);
console.log(`phase 2 executed:  ${stepsIn("2")}`);
console.log(
  `real LLM calls: ${llmCalls}  ·  get_metrics: ${n("get_metrics")}  ·  restart_service: ${n("restart_service")}  ·  send_notification: ${n("send_notification")}`,
);

const phase2Names = log.filter((e) => e.phase === "2").map((e) => e.name);
const ok =
  llmCalls === 4 && // 4 model turns total across the crash — not 5+
  n("get_metrics") === 1 &&
  n("restart_service") === 1 &&
  n("send_notification") === 1 &&
  !phase2Names.includes("get_metrics"); // the pre-crash tool was replayed, not re-run

console.log(
  ok
    ? "\n✅ REPLAY PROVEN\n" +
        "   • the pre-crash model turn + get_metrics were REPLAYED from the journal in phase 2, not re-run\n" +
        "   • the model was billed 4× total across the crash (not 5×+); get_metrics fired exactly once\n" +
        "   • restart_service and send_notification each fired exactly once — no double side effects"
    : "\n❌ replay proof failed — the counts above are off",
);
process.exit(ok ? 0 : 1);

# 5 · crash — the crash-replay proof

> **Durable-agents tour, chapter 5 of 5**
> [overview](../../README.md) · [minimal](../minimal/README.md) · [core](../core/README.md) · [sre](../sre/README.md) · [coding](../coding/README.md) · **crash**

The headline demo. Every earlier chapter *claims* that a durable agent survives a crash without
re-calling the model or re-firing a side effect — this one **proves** it: it hard-kills a worker
mid-task, restarts it, and verifies from an execution log that the pre-crash work was *replayed*
from the journal, not re-run.

Two files:

- [`worker.ts`](./worker.ts) — a headless durable worker running the [SRE persona](../sre/agent.ts)
  with an auto-approver (no human in this proof). In `PHASE=1` it crashes on cue; in `PHASE=2` it
  rejoins the same group and finishes the run.
- [`demo.ts`](./demo.ts) — spawns phase 1, then phase 2, then reads the log and prints a verdict.

## The choreography

| Durable step | Phase 1 | Phase 2 |
| --- | --- | --- |
| `llm-0` — decide | **executed** + journaled | replayed |
| `tool-0-0` — `get_metrics` | **executed** + journaled, then 💥 `process.exit(137)` | replayed |
| `llm-1` — decide | — | **executed** |
| `approve-1-0` — restart approval | — | auto-approved |
| `tool-1-0` — `restart_service` | — | **executed** |
| `llm-2` — decide | — | **executed** |
| `tool-2-0` — `send_notification` | — | **executed** |
| `llm-3` — final answer | — | **executed** |

Phase 1 dispatches the run and dies the instant `get_metrics` is journaled — the crash trigger is
the driver's `afterStep` hook ([`core/resonate.ts`](../core/resonate.ts)) firing on the step name
`tool-0-0` (the name [`core/effects.ts`](../core/effects.ts) gives the first tool call). Exit code
137 is the classic SIGKILL code: a worker death, not a graceful shutdown.

Phase 2 starts a fresh worker in the **same group** (`sre-crash`) with the **same run id** —
`beginRun` with an existing id attaches to the run instead of starting a new one. The worker was
created with a short dispatch lease (`ttl: 5000`, instead of the default of about a minute) so the
server notices the orphaned run within seconds and re-dispatches it. The generator then restarts
from the top: the journaled `llm-0` and `tool-0-0` fast-forward — their recorded results return
without the functions being invoked — and live execution resumes at `llm-1`.

## How "real vs replayed" is measured

Every **real** execution appends a line to a JSONL log (`$TMPDIR/de-crash-exec.jsonl`): the LLM
client is wrapped to log each actual `decide`, and the tools log via their `onCall` hook. A
replayed step returns its journaled value **without invoking the function**, so it leaves no
trace in the log — absence of a phase-2 `get_metrics` line *is* the proof. The stub brain keeps
the whole thing deterministic: same crash point, same counts, every run.

## Run it

Needs the [chapter-3 infrastructure](../sre/README.md#live--a-real-synadia-agent-servets) —
`nats-server -js` and `resonate-on-nats serve` (the journal that survives the crash lives in
JetStream). Then:

```sh
bun run crash
```

```
phase 1 executed:  decide, get_metrics
phase 2 executed:  decide, restart_service, decide, send_notification, decide
real LLM calls: 4  ·  get_metrics: 1  ·  restart_service: 1  ·  send_notification: 1

✅ REPLAY PROVEN
   • the pre-crash model turn + get_metrics were REPLAYED from the journal in phase 2, not re-run
   • the model was billed 4× total across the crash (not 5×+); get_metrics fired exactly once
   • restart_service and send_notification each fired exactly once — no double side effects
```

The verdict asserts exactly: 4 real LLM calls total, each tool fired exactly once, and no
`get_metrics` in phase 2. The process exits non-zero if any of that fails.

**Why 4 and not 5+?** Without a journal, restarting means starting over: `llm-0` and
`get_metrics` run again — at least 5 model calls, and every already-fired side effect fires
twice. With tools like `restart_service` or `send_notification`, that's not just a billing bug —
it's a second production restart and a duplicate page.

## Details worth stealing

- **Dotless run ids** — in Resonate a dot denotes parent/child lineage, so root ids are minted
  dot-free (`sre-crash-<timestamp>`).
- **Short leases for fast failover** — `ttl: 5000` makes orphan re-dispatch a seconds-scale
  event; the default is tuned for production patience, not demos.
- **Observability without touching the loop** — both the execution log and the crash trigger
  hang off hooks (`onCall`, `afterStep`); the agent code is byte-identical to chapter 3's.

## That's the tour

1. [minimal](../minimal/README.md) — durability is two `ctx.run` wraps.
2. [core](../core/README.md) — the loop written once, engine-neutrally; a tiny driver per engine.
3. [sre](../sre/README.md) — a real Synadia agent with approval-as-chat-query.
4. [coding](../coding/README.md) — same loop, new tools: "one loop, many agents."
5. **crash** — the replay, proven.

Back to the [overview](../../README.md) — and re-read
[`minimal/index.ts`](../minimal/index.ts): after this tour it should read as obvious.

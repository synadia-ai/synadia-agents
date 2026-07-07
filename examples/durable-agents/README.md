# Durable agents on NATS (with the Resonate SDK)

**A tool-calling agent's loop _is_ a durable workflow.** Wrap each model turn and each tool call in a
durable step and the agent gains, for free:

- **crash-resume** — kill the process mid-task; it resumes exactly where it left off;
- **no re-billing** — a completed model turn replays from the journal, never re-called;
- **exactly-once effects** — a completed tool call never re-fires its side effect on replay.

Durability comes from the **[Resonate](https://resonatehq.io) TypeScript SDK** (`@resonatehq/sdk`)
running over **NATS** (via the `resonate-on-nats` server). Each agent is a real Synadia agent —
prompted over NATS through the [Agents SDK](../../client-sdk/typescript) — whose brain is a Resonate
durable function.

## What's here

| Path | What it shows | Infra |
| --- | --- | --- |
| [`src/minimal/`](./src/minimal) | **Durability in ~10 lines** — a plain agent loop made durable with nothing but two `yield* ctx.run(...)` wraps. Native Resonate SDK, no abstraction. | none |
| [`src/sre/`](./src/sre) | A concrete **SRE agent** (metrics → restart-with-approval → notify) on a thin **durable-execution abstraction**, run as a real Synadia agent with human approval surfaced as an in-chat query. | NATS + resonate-on-nats |
| [`src/coding/`](./src/coding) | A **coding agent** ("durable Claude Code") — the _same_ abstraction, a different tool-set: sandboxed read/list/grep/write + an approval-gated `run_bash`. Proves "one loop, many agents." | NATS + resonate-on-nats |
| [`src/crash/`](./src/crash) | The **crash-replay proof** — kill a worker mid-task, restart it, and verify the pre-crash model turn + tool were replayed, not re-run. | NATS + resonate-on-nats |

## The one idea

```
messages = [system, user]
loop:
  decision = ctx.run(() => model(messages, tools))   # nondeterministic, $$$ → durable step (journaled once)
  if no tool calls: return answer
  for each call:
    if dangerous: await approval                       # human gate          → durable promise (signal)
    result = ctx.run(() => tool(call.args))            # side effect          → durable step (journaled once)
    messages += result
```

On crash the whole loop replays from the journal: recorded turns and tool results return instantly,
and execution resumes at the first un-journaled step.

## Architecture

- **Brain = a Resonate durable function.** The agent loop ([`core/effects.ts`](./src/core/effects.ts))
  is **engine-neutral**: it `yield`s `step`/`signal` effect descriptors and knows nothing about any
  durable-execution engine. A ~15-line driver ([`core/resonate.ts`](./src/core/resonate.ts))
  interprets those effects on Resonate. Supporting another DE framework later means writing one more
  small driver — the agent itself never changes.
- **Front-door = `AgentService.onPrompt`** ([`core/frontdoor.ts`](./src/core/frontdoor.ts)) — a thin,
  **non-durable** relay: it dispatches the run over NATS, streams progress, and bridges each parked
  approval to a §7 **query** (answered in chat), routing the reply to `resonate.promises.resolve`.
  It can die and restart without losing the run — session/transport is ephemeral, the brain is durable.

## Run it

### Track 1 — minimal (no infrastructure)

```sh
bun install
bun run minimal
```

A durable agent on Resonate's in-memory server. Read the ~10 lines to see the two `yield* ctx.run(...)`
wraps that are the entire durability story.

### Infrastructure (needed for the SRE + crash examples)

```sh
# 1) a NATS server with JetStream (≥ 2.14 — Resonate's durable timers ride native message scheduling)
nats-server -js -sd /tmp/de-nats

# 2) the Resonate server on that NATS (built from the resonate-on-nats repo)
go build -o resonate-on-nats . && ./resonate-on-nats serve --nats-url nats://localhost:4222
```

### Track 2 — the SRE agent

```sh
bun run sre:offline     # deterministic smoke on the in-memory server (no infra) — proves the loop

bun run sre:serve       # runs it as a real Synadia agent on NATS (deterministic stub brain)
bun run prompt          # in another terminal: discovers, prompts, and auto-approves the restart

# …or with a real local model:
LLM_BACKEND=ollama OLLAMA_MODEL=gpt-oss:latest bun run sre:serve
```

Once `sre:serve` is running, the agent also shows up in [`../agent-web-ui`](../agent-web-ui) with zero
config — prompt it there and answer the approval as an in-chat allow/deny query.

### The coding agent ("durable Claude Code")

The _same_ core, a different tool-set — sandboxed fs ops plus an approval-gated `run_bash`:

```sh
bun run coder:offline                                        # deterministic smoke (no infra)

bun run coder:serve                                          # a real Synadia agent on NATS
AGENT=durable-coder bun run prompt "add hello.py and run it" # in another terminal

# …or with a real local coding model:
LLM_BACKEND=ollama OLLAMA_MODEL=qwen3.6:35b-mlx bun run coder:serve
```

Kill `coder:serve` mid-task and restart it (same group) and the run resumes from the journal exactly
like the crash-replay proof below — a completed `write_file` or `run_bash` never re-fires.

### The crash-replay proof (the headline)

```sh
bun run crash
```

Runs the agent, hard-crashes the worker the instant `get_metrics` is journaled, restarts it, and
prints a verdict proving the pre-crash work was replayed rather than re-executed:

```
phase 1 executed:  decide, get_metrics
phase 2 executed:  decide, restart_service, decide, send_notification, decide
real LLM calls: 4  ·  get_metrics: 1  ·  restart_service: 1  ·  send_notification: 1
✅ REPLAY PROVEN — the model was billed 4× total across the crash (not 5×+); every tool fired exactly once.
```

## The abstraction — why the loop is engine-neutral

Resonate is generator-based (`yield*`), so the shared layer can't be an `async/await` interface — it
is an **effects generator** instead: the loop yields plain `{t:"step"|"signal", …}` descriptors and a
per-engine driver interprets them. This keeps the agent one file with no engine imports, so the same
agent can be pointed at **future durable-execution frameworks** by adding a second small driver.

## File map

```
src/
  minimal/index.ts     Track 1 — native Resonate, self-contained
  core/
    effects.ts         engine-neutral agentLoop + types
    resonate.ts        driveResonate — the only Resonate-aware code
    subjects.ts        shared NATS subjects (the approval side-channel)
    llm.ts             LLM client — deterministic stub + OpenRouter + Ollama
    frontdoor.ts       AgentService front-door + approval-as-query bridge
  sre/                 the SRE agent — tools + prompt + offline smoke + serve
  coding/              the coding agent — same core, fs tools + approval-gated run_bash
  caller.ts            a tiny client: discover → prompt → auto-approve (AGENT=… picks one)
  crash/
    worker.ts          headless durable worker (crashes in phase 1, resumes in phase 2)
    demo.ts            orchestrates + verifies the crash-replay proof
```

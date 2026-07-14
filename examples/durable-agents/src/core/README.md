# 2 · core — the engine-neutral agent core

> **Durable-agents tour, chapter 2 of 5**
> [overview](../../README.md) · [minimal](../minimal/README.md) · **core** · [sre](../sre/README.md) · [coding](../coding/README.md) · [crash](../crash/README.md)

Everything the remaining chapters run is assembled from the five files in this directory. The
design has one goal: **the agent loop is written once and knows nothing about any
durable-execution engine.** It yields plain effect descriptors; a small per-engine driver
interprets them. Supporting another DE framework later means writing one more ~15-line driver —
the agent itself never changes.

| File | Role |
| --- | --- |
| [`effects.ts`](./effects.ts) | `agentLoop` — the engine-neutral loop; yields `step` / `signal` effects |
| [`resonate.ts`](./resonate.ts) | `driveResonate` — the **only** Resonate-aware code in the suite |
| [`llm.ts`](./llm.ts) | a one-turn, non-streaming LLM client: deterministic stub / OpenRouter / Ollama |
| [`frontdoor.ts`](./frontdoor.ts) | `serveAgent` — the non-durable Synadia-agent front-door + approval bridge |
| [`subjects.ts`](./subjects.ts) | the single shared NATS subject (approval announcements) |

There is nothing to run in this chapter — every later chapter executes this code.

## Two effects are the whole durable vocabulary

```ts
export type Effect =
  | { t: "step";   name: string; run: (key: string) => Promise<unknown> }
  | { t: "signal"; name: string; timeoutMs?: number; ask?: unknown };
```

- **`step`** — anything nondeterministic or side-effecting: a model turn, a tool call. The `name`
  (`llm-0`, `tool-1-0`, …) is stable across replays and doubles as the step's **idempotency
  key**: it's passed into the tool as `run(args, key)` so a real side effect can forward it to
  at-least-once infrastructure (the SRE `restart_service` tool echoes it back to make that visible).
- **`signal`** — wait for the outside world, i.e. a human approval. The loop parks until someone
  resolves it with `{ approved: boolean }`.

Why a generator and not an `async/await` interface? Resonate is generator-based (`yield*`), so
the shared layer can't be `async` — and yielding inert descriptors is precisely what keeps the
loop free of engine imports.

## `effects.ts` — the loop

[`agentLoop`](./effects.ts) holds the transcript (`system` + `user` to start) and runs up to
`maxSteps` (default 8) turns:

1. **REASON** — yield a `step` named `llm-<n>` that calls `llm.decide(messages, tools)`. If the
   decision contains no tool calls, the loop returns `{ answer, steps }` — done.
2. **ACT** — for each requested tool call:
   - unknown tool → an error message goes back into the transcript (the model gets to react);
   - a tool marked `dangerous: true` → first yield a `signal` named `approve-<step>-<i>`
     carrying `{ name, args }`; a denial pushes `"✗ denied by human"` into the transcript and
     the loop moves on — with a real backend, the model sees the denial and adapts;
   - then yield a `step` named `tool-<step>-<i>` that runs the tool.

The loop only ever advances on values fed back from durable ops, so on replay it re-yields the
identical effect sequence. The one rule, verbatim from the source: *no raw nondeterminism
(`Date.now` / `Math.random` / I/O) between yields.*

## `resonate.ts` — the driver

The only Resonate-aware code. It steps the generator and pattern-matches each effect:

```ts
if (eff.t === "step") {
  fed = yield* ctx.run(() => eff.run(eff.name));          // journaled once, replayed thereafter
  hooks?.afterStep?.(eff.name);                            // observability (the crash demo's trigger)
} else {
  const p = yield* ctx.promise<{ approved: boolean }>();   // a durable promise
  yield* ctx.run(() => notify(eff.name, p.id, eff.ask));   // announce it — as a step, so a replay
  fed = yield* p;                                          //   won't re-announce; then park
}
```

`notify` is how a parked approval reaches the world: in serve mode it publishes
`{ promiseId, ask }` on `de-agent.approval.<runId>` ([`subjects.ts`](./subjects.ts)), and anyone
holding the id can settle it via `resonate.promises.resolve(...)`. Pointing the same agent at a
different durable-execution framework means writing one more file shaped like this one.

## `llm.ts` — one turn, no streaming

The loop owns the agentic while-loop, so the client doesn't loop: it exposes a single awaitable
turn, `decide(messages, tools) → { content, toolCalls }`. It is non-streaming **by design** — a
durable step journals a *value*, and replay returns the recorded turn instead of re-calling (and
re-billing) the model. Token streaming, when wanted, belongs in the non-durable front-door as a
best-effort channel; it never rides the journal. `ChatMessage` is plain JSON for the same reason:
every transcript entry must round-trip the journal.

Backend selection is env-driven; the deterministic per-agent stub is the fallback so demos and
the crash proof are reproducible:

| Env | Effect |
| --- | --- |
| `OPENROUTER_API_KEY` | use OpenRouter (`OPENROUTER_MODEL`, default `openai/gpt-4o-mini`) |
| `LLM_BACKEND` | force `openrouter` or `ollama`; unset → key ⇒ OpenRouter, else the stub |
| `OLLAMA_URL` / `OLLAMA_MODEL` | Ollama endpoint + model (defaults `http://localhost:11434`, `llama3.1:8b`) |
| `LLM_TIMEOUT_MS` | per-call abort (default 60 000) so a hung model can't stall a durable step forever |

## `frontdoor.ts` — the non-durable face

`serveAgent(cfg)` turns a registered durable workflow into a real Synadia agent using
[`AgentService`](../../../../agent-sdk/typescript) (registration, heartbeats every 10 s). On each
prompt it:

1. mints a **dotless** run id `<agent>-<instanceId>-<seq>` (in Resonate a dot denotes
   parent/child lineage, so a root id must not contain one) and dispatches `beginRun`;
2. subscribes to that run's approval subject; each announcement becomes a §7 **query** — the
   protocol's mid-stream question to the caller — `⏸ Approve \`tool(args)\`? (yes/no)`. An
   affirmative reply (`y/yes/approve/allow/ok/true`) resolves the durable promise with
   `{ approved: true }`; anything else, or no reply within `approvalTimeoutMs` (default 5 min),
   denies;
3. awaits `handle.result()` and sends the answer back down the stream.

It is deliberately **not** durable: session and transport are ephemeral, the brain is journaled.
The approval gate lives in the journal — the in-chat query is just its live face.

## Next

**[3 · sre →](../sre/README.md)** — the first real agent built on this core: an SRE persona on
live NATS, with the approval surfacing in chat.

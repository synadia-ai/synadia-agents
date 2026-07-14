# 1 · minimal — durability in ~10 lines

> **Durable-agents tour, chapter 1 of 5**
> [overview](../../README.md) · **minimal** · [core](../core/README.md) · [sre](../sre/README.md) · [coding](../coding/README.md) · [crash](../crash/README.md)

The smallest possible durable agent. [`index.ts`](./index.ts) is an ordinary tool-calling loop —
*ask the model, run the tools it asked for, repeat* — and the **only** thing that makes it durable
is that the model call and the tool call are each wrapped in `yield* ctx.run(...)`, a
[Resonate](https://resonatehq.io) **durable step**. No abstraction, no framework glue, no
infrastructure.

## The two wraps

```ts
// (1) REASON — journaled once; after a crash it REPLAYS (never re-called, never re-billed)
const decision = yield* ctx.run(() => callModel(messages));

// (2) ACT — journaled once; the side effect fires once, never twice on replay
const result = yield* ctx.run(() => tool(call.args));
```

That's the entire durability story. Everything else in the file is a plain agent: a deterministic
stub "model" that asks for the weather once and then answers, one `get_weather` tool, and a
message transcript.

## The mental model: journal + replay

A durable step means: *run the function once, record its result in a journal, and on any
re-execution return the recorded result instead of running the function again.*

When the process dies and the run is picked up again, the generator restarts **from the top** —
but every step that already completed returns instantly from the journal. Execution fast-forwards
through the recorded history and resumes at the first step that never finished. Two consequences:

- a completed **model turn** is never re-called → a crash never re-bills you;
- a completed **tool call** never re-fires its side effect → no double restart, no double email.

The price is one rule: **code between steps must be deterministic** — no `Date.now()`,
`Math.random()`, or raw I/O outside a step — so the replayed generator takes the same path and
yields the same steps in the same order.

## Run it

```sh
bun install        # once, in examples/durable-agents/
bun run minimal
```

```
🧠 agent answer: Here you go — Berlin: 21°C, clear.
```

`new Resonate()` with no URL runs an **in-memory** Resonate server inside the process — ideal for
reading the mechanics, but the journal dies with the process. The wraps don't change at all when
you point Resonate at a real server over NATS; that is exactly what the [sre](../sre/README.md)
and [crash](../crash/README.md) chapters do, and where crash-resume becomes real.

## Things to try

- Swap `callModel` for a real backend (OpenAI-compatible, Ollama, …) — it changes nothing about
  the durability story; the loop and the wraps stay identical.
- Add a second tool and have the stub "model" call both — each call becomes its own journaled step.
- Break the rule on purpose: branch on `Math.random()` between steps and reason about why a
  replay could then diverge from the recorded history.

## Next

**[2 · core →](../core/README.md)** — here the wraps were written directly against Resonate. The
rest of the suite factors them out: the agent loop is written once, engine-neutrally, and a
~15-line driver supplies the durability.

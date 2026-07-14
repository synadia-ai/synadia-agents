# 3 · sre — a durable SRE agent on NATS

> **Durable-agents tour, chapter 3 of 5**
> [overview](../../README.md) · [minimal](../minimal/README.md) · [core](../core/README.md) · **sre** · [coding](../coding/README.md) · [crash](../crash/README.md)

The first real agent built on the [core](../core/README.md): a Synadia agent you can discover and
prompt over NATS, whose brain is a durable workflow. The scenario is an SRE incident: investigate
a slow service with read-only tools, restart it **only after a human approves**, then notify
on-call and summarize.

## The persona ([`agent.ts`](./agent.ts))

One file defines everything agent-specific — system prompt, tools, and a deterministic offline
script. The other two files are just entry points.

| Tool | What it does | Durable shape |
| --- | --- | --- |
| `get_metrics` | returns (canned) unhealthy p99 / error-rate / saturation for a service | plain step |
| `restart_service` | "restarts" the service — disruptive | **`dangerous: true`** → parks on an approval signal first; echoes its idempotency `key` back so exactly-once is visible in the output |
| `send_notification` | posts to the on-call channel | plain step |

The stub brain ([`sreStub`](./agent.ts)) is a fixed playbook — *pull metrics → restart (needs
approval) → notify → final summary* — computed purely from how many tool results are in the
transcript. Being a pure function of the transcript makes it deterministic and replay-safe, which
is what lets the [crash chapter](../crash/README.md) assert exact call counts. Tools accept an
`onCall` hook so a harness can count real executions — the exactly-once proof in miniature.

## Offline smoke — no infrastructure

```sh
bun run sre:offline
```

Runs the durable brain on Resonate's in-memory server with the stub and an auto-approver:

```
▶ SRE agent (durable brain, offline in-memory Resonate):
   · get_metrics  [key=tool-0-0]
   🔔 approval requested: {"name":"restart_service","args":{"service":"checkout"}} → approving
   · restart_service  [key=tool-1-0]
   · send_notification  [key=tool-2-0]

🧠 answer: Done: checkout was unhealthy, I restarted it (with approval) and metrics are recovering.
   tool executions: {"get_metrics":1,"restart_service":1,"send_notification":1}
✅ every tool executed exactly once
```

It exits non-zero if any tool ran more or less than once, so it doubles as a fast test of the
whole loop + approval gate.

## Live — a real Synadia agent ([`serve.ts`](./serve.ts))

```
caller ──prompt──▶ AgentService front-door ──beginRun──▶ Resonate worker (same process)
                         │                                    │
                         │  approval as §7 query              │  durable steps journaled to
                         ▼                                    ▼  resonate-on-nats over NATS
                    the human answers                    JetStream (survives a crash)
```

Infrastructure first (also needed by the [coding](../coding/README.md) and
[crash](../crash/README.md) chapters):

```sh
# 1) a NATS server with JetStream (≥ 2.14 — Resonate's durable timers ride native message scheduling)
nats-server -js -sd /tmp/de-nats

# 2) the Resonate server on that NATS (built from the resonate-on-nats repo)
go build -o resonate-on-nats . && ./resonate-on-nats serve --nats-url nats://localhost:4222
```

Then, in two terminals:

```sh
bun run sre:serve       # the agent: durable worker + front-door in one process
bun run prompt          # a caller: discovers, prompts, and auto-answers the approval
```

The caller ([`../caller.ts`](../caller.ts)) prints the whole §7 conversation:

```
prompting durable-sre/<owner>/sre:
  "checkout is slow — investigate and fix."

  [status] ack
  [status] ▶ durable run `durable-sre-<instance>-1`
  [query]  ⏸ Approve `restart_service({"service":"checkout"})`? (yes/no)
           → replying "yes"
  [status] ✅ approved
  [answer] Done: checkout was unhealthy, I restarted it (with approval) and metrics are recovering.

✅ prompt complete
```

Once `sre:serve` is up, the agent also appears in [`agent-web-ui`](../../../agent-web-ui) with
zero config — prompt it there and the approval renders as an in-chat allow/deny query.

Knobs (all env):

| Env | Default | Meaning |
| --- | --- | --- |
| `NATS_URL` | `nats://127.0.0.1:4222` | NATS to connect to (agent and caller) |
| `RESONATE_GROUP` | `sre-workers` | Resonate worker group — restart into the **same** group to resume runs |
| `APPROVE` | `yes` | caller's scripted answer to the approval query (`APPROVE=no` denies) |
| `AGENT` | `durable-sre` | which agent type the caller prompts (`durable-coder` for chapter 4) |
| `LLM_BACKEND` … | *(stub)* | real brain, e.g. `LLM_BACKEND=ollama OLLAMA_MODEL=gpt-oss:latest bun run sre:serve` — see [core → `llm.ts`](../core/README.md) |

## Things to try

- **Deny the restart**: `APPROVE=no bun run prompt`. The tool never fires and the transcript gets
  `✗ denied by human`. (Caveat: the deterministic stub follows its script regardless of the
  denial — swap in a real backend to watch the model actually adapt.)
- **Watch the approval side-channel**: `nats sub 'de-agent.approval.>'` while prompting — that's
  the parked promise being announced ([`core/subjects.ts`](../core/subjects.ts)).
- **Kill `sre:serve` mid-run and restart it** (same `RESONATE_GROUP`): the *run* resumes from the
  journal and completes — but the caller's live stream is gone, because the front-door is
  deliberately ephemeral. That asymmetry — durable brain, disposable face — is the architecture
  working as intended; the [crash chapter](../crash/README.md) turns it into a verified proof.

## Next

**[4 · coding →](../coding/README.md)** — the same loop, driver, and front-door with a different
tool-set: "one loop, many agents."

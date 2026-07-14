# 4 · coding — "durable Claude Code"

> **Durable-agents tour, chapter 4 of 5**
> [overview](../../README.md) · [minimal](../minimal/README.md) · [core](../core/README.md) · [sre](../sre/README.md) · **coding** · [crash](../crash/README.md)

The same [core](../core/README.md) — loop, driver, LLM client, front-door — with a different
tool-set: a coding agent that works inside a sandboxed directory and needs human approval to run
shell commands. Diff this chapter against [sre](../sre/README.md) and you'll find the entire
difference is one persona file plus names: **one loop, many agents.**

## The tool-set ([`agent.ts`](./agent.ts))

| Tool | What it does | Durable shape |
| --- | --- | --- |
| `list_dir` | list a directory in the sandbox | plain step |
| `read_file` | read a file in the sandbox | plain step |
| `grep` | recursive search in the sandbox (output capped at 4 kB) | plain step |
| `write_file` | create/overwrite a file (parent dirs auto-created) | plain step |
| `run_bash` | run a shell command, sandbox as cwd, 15 s timeout, output capped at 4 kB | **`dangerous: true`** → human approval first |

Safety is deliberate and small: every path goes through `safe()`, which resolves it inside the
sandbox root and rejects traversal (`path escapes sandbox`); `grep` and `run_bash` execute with
the sandbox as their working directory. A real deployment would also allow-list commands — the
source says so out loud.

## Why durability matters for a coding agent

A coding agent is mid-task state *par excellence*: it has written three files and is about to run
the build when the host dies. On restart in the same worker group, the run resumes from the
journal — completed `write_file` and `run_bash` steps **never re-fire**, finished model turns are
**never re-billed**, and the approval that let `run_bash` through is journaled like everything
else. Restarting mid-refactor is safe by construction.

## Run it

Offline smoke — in-memory Resonate, deterministic stub, a throwaway temp-dir sandbox,
auto-approval:

```sh
bun run coder:offline
```

```
▶ coding agent (durable brain, offline; sandbox …/de-coder-XXXXXX):
   · write_file  [key=tool-0-0]
   · read_file  [key=tool-1-0]
   🔔 approval requested: {"name":"run_bash","args":{"cmd":"wc -c greeting.txt"}} → approving
   · run_bash  [key=tool-2-0]

🧠 answer: Done: wrote greeting.txt, read it back, and measured it with wc.
   tool executions: {"write_file":1,"read_file":1,"run_bash":1}
✅ tools executed as scripted (write, read, approval-gated bash)
```

Live — with the [same infrastructure as chapter 3](../sre/README.md#live--a-real-synadia-agent-servets)
(`nats-server -js` + `resonate-on-nats serve`):

```sh
bun run coder:serve                                           # agent type `durable-coder`
AGENT=durable-coder bun run prompt "add hello.py and run it"  # in another terminal
```

(Set `AGENT` — the caller falls back to the *first* agent it discovers when the requested type
isn't found, which may be your SRE agent from chapter 3.)

The serve process uses `./coding-sandbox/` at the package root as its sandbox (override with
`CODING_SANDBOX=/path`); the offline smoke always uses a fresh temp dir. For a real brain, pick a
coding-capable local model:

```sh
LLM_BACKEND=ollama OLLAMA_MODEL=qwen3.6:35b-mlx bun run coder:serve
```

## Things to try

- **Deny the bash step**: `APPROVE=no AGENT=durable-coder bun run prompt` — `run_bash` never
  executes. (Same caveat as chapter 3: the stub's script doesn't react to the denial; a real
  backend does.)
- **Kill `coder:serve` mid-task and restart it** (same `RESONATE_GROUP`, default
  `coder-workers`): the run resumes from the journal — a completed `write_file` or `run_bash`
  never re-fires, exactly like the [crash-replay proof](../crash/README.md).
- **Grow the persona**: add a `delete_file` tool to [`agent.ts`](./agent.ts) and decide whether
  it's `dangerous`. One `Tool` entry is the entire cost of a new capability — the loop, journal,
  and approval plumbing come for free.

## Next

**[5 · crash →](../crash/README.md)** — stop taking "resumes from the journal" on faith: kill a
worker mid-task and *prove* the replay.

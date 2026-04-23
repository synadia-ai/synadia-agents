# Examples

Runnable demos ported from the [TypeScript SDK](https://github.com/synadia-ai/synadia-agents/tree/main/client-sdk/typescript),
plus a Python-only interactive chat REPL. Start the reference agent in
one terminal, then point the numbered demos at it from another. A user
comparing the two SDKs should find the same demo set on both sides.

## The scripts

| File | What it does |
| --- | --- |
| [`_reference_agent.py`](_reference_agent.py) | Spec-compliant echo agent - run this first so the numbered demos have something to talk to. Keeps a small per-session conversation memory (capped at 20 turns) so multi-turn chats across invocations feel alive. |
| [`01-discover.py`](01-discover.py) | Enumerate every reachable agent via `$SRV.PING.agents` and print identity + capabilities. |
| [`02-prompt-text.py`](02-prompt-text.py) | Send a text prompt to the first discovered agent and stream the response to stdout. Accepts `--session NAME` (see below). |
| [`03-prompt-attachment.py`](03-prompt-attachment.py) | Prompt with a file attached; shows §5.4 pre-publish validation (`max_payload`, `attachments_ok`). Accepts `--session NAME`. |
| [`04-query-reply.py`](04-query-reply.py) | Answer mid-stream queries the agent asks (permission prompts, clarifications). Accepts `--session NAME`. |
| [`05-liveness.py`](05-liveness.py) | Passive wildcard subscription that prints every agent's heartbeat as it arrives. |
| [`06-chat.py`](06-chat.py) | Interactive chat REPL with a `rich`-powered TUI. Requires `uv sync --extra examples`. |
| [`_connect_cli.py`](_connect_cli.py) | (internal plumbing; not a demo) - shared `--context` / `--url` / `$NATS_URL` resolver. |

## Start here

```shell
# terminal 1 - start the reference agent
uv run python examples/_reference_agent.py --url nats://127.0.0.1:4222

# terminal 2 - discover it and prompt it
uv run python examples/01-discover.py --url nats://127.0.0.1:4222
uv run python examples/02-prompt-text.py --url nats://127.0.0.1:4222 "hello"
```

## Multi-turn chat

The protocol has a **two-layer session model**. Both work, and the
reference agent (and any well-behaved agent) supports both.

### Layer 1 - subject-level session (default, no flag needed)

Session-aware harnesses like `claude-code` and `pi` register each session
as its own NATS subject (§2 + §3.2) - the 4th subject token IS the session
label. Two prompts to the same subject = same conversation, no envelope
field required:

```shell
uv run python examples/02-prompt-text.py "hi, I'm rene"
uv run python examples/02-prompt-text.py "what did I just say?"
# → agent recaps your first turn
```

### Layer 2 - envelope-level session (`--session NAME`)

Some harnesses (Hermes-style) run one registration that multiplexes many
conversations over a single subject. `--session NAME` is the caller's
per-request discriminator (§5.1). Independent labels yield independent
histories on the **same** subject:

```shell
uv run python examples/02-prompt-text.py --session alice "hi from alice"
uv run python examples/02-prompt-text.py --session bob   "hi from bob"
uv run python examples/02-prompt-text.py --session alice "who am I?"
# → agent recaps alice's turn, not bob's
```

### Interactive REPL

`06-chat.py` wraps the same two modes in a `rich`-powered TUI. Without
`--session` it drives a subject-level chat; with `--session NAME` it
drives one of many multiplexed conversations. Install `rich` first:

```shell
uv sync --extra examples
uv run python examples/06-chat.py                    # subject-level
uv run python examples/06-chat.py --session mychat   # envelope-level
```


## Connecting to NATS

Every numbered example honours the same flag resolution, in order:

1. `--context <name>` - load `~/.config/nats/context/<name>.json`
2. `--url <url>` - direct URL (overrides `$NATS_URL`)
3. `$NATS_URL` - convenience default for demos (the SDK itself does not read it)
4. selected context - `$NATS_CONTEXT` or the output of `nats context select`

If none of those resolve, the demo exits with a pointed error. See
[`CLAUDE.md`](../CLAUDE.md#connecting-to-nats) for the full
`natsagent.connect()` contract (XDG paths, supported context fields,
unsupported-feature failures).

## Caveat on `04-query-reply.py`

The reference agent's echo handler does **not** emit mid-stream queries,
so running `04` against it will just stream the echo back without ever
hitting the interactive path. To exercise the query/reply round-trip,
point `04` at an agent whose handler calls `stream.ask(...)`.

## See also

- [Root README](../README.md) - conceptual quickstarts for the two
  personas (agent author, client author).
- [Protocol spec](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md)
  - wire-level source of truth.

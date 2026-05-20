# Examples

Client-side demos ported from the [TypeScript SDK](https://github.com/synadia-ai/synadia-agents/tree/main/client-sdk/typescript),
plus a Python-only interactive chat REPL. Start the reference agent
from the [`agent-sdk/python/`](../../../agent-sdk/python/) sibling in
one terminal, then point the numbered demos at it from another. A user
comparing the two SDKs should find the same client-side demo set on
both sides; the host-side reference agent now ships with the
`synadia-ai-agent-service` distribution.

## The scripts

| File | What it does |
| --- | --- |
| [`01-discover.py`](01-discover.py) | Enumerate every reachable agent via `$SRV.INFO.agents` and print identity + capabilities. |
| [`02-prompt-text.py`](02-prompt-text.py) | Send a text prompt to the first discovered agent and stream the response to stdout. Accepts `--session NAME` to filter discovery by `session_name`. |
| [`03-prompt-attachment.py`](03-prompt-attachment.py) | Prompt with a file attached; shows §5.4 pre-publish validation (`max_payload`, `attachments_ok`). Accepts `--session NAME`. |
| [`04-query-reply.py`](04-query-reply.py) | Answer mid-stream queries the agent asks (permission prompts, clarifications). Accepts `--session NAME`. |
| [`05-liveness.py`](05-liveness.py) | Per-instance heartbeat listener + periodic liveness snapshot. |
| [`06-chat.py`](06-chat.py) | Interactive chat REPL with a `rich`-powered TUI. Requires `uv sync --extra examples`. |
| [`_connect_cli.py`](_connect_cli.py) | (internal plumbing; not a demo) - shared `--context` / `--url` / `$NATS_URL` resolver. |

The reference agent (`_reference_agent.py`) lives in the agent-sdk
sibling at
[`../../../agent-sdk/python/examples/_reference_agent.py`](../../../agent-sdk/python/examples/_reference_agent.py)
— the same spec-compliant echo agent used by the agent-sdk's tests,
runnable directly from there.

## Start here

```shell
# terminal 1 - start the reference agent (from the agent-sdk sibling)
uv run --directory ../../agent-sdk/python python examples/_reference_agent.py \
  --url nats://127.0.0.1:4222

# terminal 2 - discover it and prompt it
uv run python examples/01-discover.py --url nats://127.0.0.1:4222
uv run python examples/02-prompt-text.py --url nats://127.0.0.1:4222 "hello"
```

## Multi-turn chat

Under v0.3 the protocol has **one** session model: the 5th NATS subject
token (the `session_name`) IS the session. Each registered service
serves one logical session; a worker that wants to host two
conversations registers two services with different `session_name`
values. The previous envelope-level multiplexing pattern (Hermes-style)
is gone.

### One chat = one subject = one session

Two prompts hitting the same agent's subject = same conversation, no
envelope field required:

```shell
uv run python examples/02-prompt-text.py "hi, I'm rene"
uv run python examples/02-prompt-text.py "what did I just say?"
# → agent recaps your first turn
```

### Selecting between sessions

`--session NAME` filters discovery to the agent whose `session_name`
matches. Run two reference agents under different session names to host
two independent conversations:

```shell
# terminal 1 - alice's session (reference agent ships with the agent-sdk)
uv run --directory ../../agent-sdk/python python examples/_reference_agent.py \
  --session-name alice
# terminal 2 - bob's session
uv run --directory ../../agent-sdk/python python examples/_reference_agent.py \
  --session-name bob
# terminal 3 - drive each via discovery filter (this dist)
uv run python examples/02-prompt-text.py --session alice "hi from alice"
uv run python examples/02-prompt-text.py --session bob   "hi from bob"
```

### Interactive REPL

`06-chat.py` wraps the same single-session model in a `rich`-powered
TUI. The REPL talks to the first discovered agent, and one chat = one
session = one subject. Install `rich` first:

```shell
uv sync --extra examples
uv run python examples/06-chat.py
```


## Connecting to NATS

Every numbered example honours the same flag resolution, in order:

1. `--context <name>` - load `~/.config/nats/context/<name>.json`
2. `--url <url>` - direct URL (overrides `$NATS_URL`)
3. `$NATS_URL` - convenience default for demos (the SDK itself does not read it)
4. selected context - `$NATS_CONTEXT` or the output of `nats context select`

If none of those resolve, the demo exits with a pointed error. See
[`CLAUDE.md`](../CLAUDE.md#connecting-to-nats) for the full
`synadia_ai.agents.load_context_options()` contract (XDG paths, supported context
fields, unsupported-feature failures). The SDK itself does not open NATS
connections — every example builds a `nats.aio.client.Client` via
`nats.connect(**load_context_options(...))` and hands it to `Agents`.

## Caveat on `04-query-reply.py`

The reference agent's echo handler does **not** emit mid-stream queries,
so running `04` against it will just stream the echo back without ever
hitting the interactive path. To exercise the query/reply round-trip,
point `04` at an agent whose handler calls `stream.ask(...)`.

## See also

- [Root README](../README.md) - conceptual quickstarts for the two
  personas (agent author, client author).
- [Protocol spec](https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md)
  - wire-level source of truth.

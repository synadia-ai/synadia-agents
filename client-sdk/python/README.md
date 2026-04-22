# natsagent

Python SDK for the [NATS Agent Protocol](docs/nats-agent-protocol.md)
(v0.1). Register Python agents over NATS so they're discoverable via
`$SRV.PING.SynadiaAgents`, and prompt them from callers with streamed
typed responses.

**Wire-compatible with the [TypeScript SDK](../typescript)** — the
two are validated against each other on every CI run via
[`tests/test_interop_e2e.py`](tests/test_interop_e2e.py).

## Installation

```bash
pip install natsagent            # once published to PyPI
# or, from this checkout:
uv pip install -e .
```

Prereq: a reachable `nats-server`. Local dev:

```bash
brew install nats-server         # macOS
nats-server -a 127.0.0.1 -p 4222
```

## Quickstart — host an agent

```python
import asyncio, nats
from natsagent import Agent, Envelope, PromptStream

async def echo(envelope: Envelope, stream: PromptStream) -> None:
    await stream.send(f"echo: {envelope.prompt}")

async def main() -> None:
    nc = await nats.connect("nats://127.0.0.1:4222")
    agent = Agent(
        agent="demo",            # your harness identifier
        owner="alice",           # your operator / account
        name="worker-1",         # this instance's name
        nc=nc,
        description="demo echo agent",
    )
    agent.on_prompt(echo)
    await agent.start()
    try:
        await asyncio.Event().wait()   # run until Ctrl-C
    finally:
        await agent.stop()
        await nc.close()

asyncio.run(main())
```

Probe it with the `nats` CLI:

```bash
nats micro list                                     # see "SynadiaAgents"
nats req agents.demo.alice.worker-1 "hello"         # prompt it
nats sub  "agents.demo.alice.worker-1.heartbeat"    # watch heartbeats
```

## Quickstart — call an agent

```python
import asyncio, nats
from natsagent import Client

async def main() -> None:
    nc = await nats.connect("nats://127.0.0.1:4222")
    client = Client(nc=nc)
    await client.start()

    found = await client.discover(timeout=2.0)
    for a in found:
        print(f"{a.agent}/{a.owner}/{a.name} @ {a.inbox}")

    # Bind to the first one by identity; pass the whole DiscoveredAgent
    # so the SDK can enforce §5.4 max_payload / attachments_ok locally.
    remote = client.bind(found[0])

    async for chunk in remote.prompt("hello", timeout=5.0):
        print(chunk)

    await client.stop()
    await nc.close()

asyncio.run(main())
```

## Mid-stream queries

Agent handlers can pause their response stream to ask the caller a
question (permission prompt, clarification, menu selection):

```python
async def confirm(envelope: Envelope, stream: PromptStream) -> None:
    await stream.send("planning...")
    answer = await stream.ask("Proceed? (yes/no)", timeout=10.0)
    if answer.prompt.strip().lower() == "yes":
        await stream.send("done")
    else:
        await stream.send("aborted")
```

The caller replies inline — the stream stays open across the round-trip:

```python
async for msg in remote.prompt("do the thing", timeout=30.0):
    if isinstance(msg, Query):
        await msg.reply("yes")
    else:
        print(msg)     # ResponseChunk / StatusChunk
```

## Documentation

- [`docs/nats-agent-protocol.md`](docs/nats-agent-protocol.md) — the
  protocol spec (source of truth).
- [`docs/protocol-mapping.md`](docs/protocol-mapping.md) — every SDK call
  mapped to its spec section; for auditors and other-SDK implementers.
- [`docs/nats-agent-sdk.md`](docs/nats-agent-sdk.md) — design notes and
  Python-specific resolutions.
- [`CLAUDE.md`](CLAUDE.md) — project context and engineering conventions.

## Development

```bash
uv sync                              # install
uv run pytest                        # unit + e2e (needs nats-server on PATH)
uv run ruff check . && uv run mypy src tests
```

Integration tests spawn a real `nats-server` per session and record wire
evidence under `tests/_evidence/<test-nodeid>/`. Cross-SDK interop tests
(`tests/test_interop_e2e.py`) additionally spawn the TypeScript
reference agent via `bun`; they skip cleanly if `bun` or the sibling
`../typescript/` checkout isn't present.

## License

Apache-2.0. See [LICENSE](LICENSE).

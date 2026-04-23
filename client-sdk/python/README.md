# natsagent

Python SDK for the [NATS Agent Protocol](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md)
(v0.2). Register Python agents over NATS so they're discoverable via
`$SRV.PING.agents`, and prompt them from callers with streamed
typed responses.

**Cross-SDK parity with the [TypeScript SDK](https://github.com/synadia-ai/synadia-agents/tree/main/client-sdk/typescript)**
is tracked in [`tests/test_interop_e2e.py`](tests/test_interop_e2e.py).
The TS SDK is currently still on protocol v0.1 while this release is on
v0.2, so the interop tests are marked `xfail` until the TS side bumps
— see [`CHANGELOG.md`](CHANGELOG.md) under `[0.2.0] › Interop`.

**Agent author?** → [Quickstart — host an agent](#quickstart--host-an-agent).
**Client / UI author?** → [Quickstart — call an agent](#quickstart--call-an-agent).

## Installation

From this checkout (no published wheel yet):

```bash
uv pip install -e .
```

Once released on PyPI:

```bash
pip install natsagent
```

You also need a reachable `nats-server`. Pick whichever fits:

```bash
brew install nats-server                          # macOS
# Linux / anywhere with Docker:
docker run --rm -p 4222:4222 nats:2.12-alpine
# Then:
nats-server -a 127.0.0.1 -p 4222
```

See the [nats.io install docs](https://docs.nats.io/running-a-nats-service/introduction/installation)
for more options. [Synadia Cloud](https://www.synadia.com/cloud/) or
any hosted NATS works too — see
[Connecting to NATS in production](#connecting-to-nats-in-production)
below.

## Quickstart — host an agent

```python
import asyncio
import natsagent
from natsagent import Agent, Envelope, PromptStream

async def echo(envelope: Envelope, stream: PromptStream) -> None:
    await stream.send(f"echo: {envelope.prompt}")

async def main() -> None:
    nc = await natsagent.connect(servers="nats://127.0.0.1:4222")
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
nats micro list                                     # see "agents"
nats req agents.demo.alice.worker-1 "hello"         # prompt it
nats sub  "agents.demo.alice.worker-1.heartbeat"    # watch heartbeats
```

## Quickstart — call an agent

```python
import asyncio
import natsagent
from natsagent import Client

async def main() -> None:
    nc = await natsagent.connect(servers="nats://127.0.0.1:4222")
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

## Try the examples

Six runnable demos live under [`examples/`](examples/README.md). The
three-line ritual to see the SDK work end-to-end:

```shell
# terminal 1
uv run python examples/_reference_agent.py --url nats://127.0.0.1:4222

# terminal 2
uv run python examples/01-discover.py --url nats://127.0.0.1:4222
uv run python examples/02-prompt-text.py --url nats://127.0.0.1:4222 "hello"
```

See [`examples/README.md`](examples/README.md) for the full tour.

## Connecting to NATS in production

For [Synadia Cloud](https://www.synadia.com/cloud/) or any self-hosted
NATS that needs credentials, JWTs, or a non-default URL, use a `nats`
CLI context and pass its name to `natsagent.connect`:

```python
nc = await natsagent.connect(context="prod")
```

This loads `~/.config/nats/context/<name>.json` — URL, creds file,
token, user/password, inbox prefix are all honoured. See
[`CLAUDE.md`](CLAUDE.md#connecting-to-nats) for the full field-by-field
table (including which NATS-context fields are not yet supported and
fail fast rather than silently).

## Documentation

- [NATS Agent Protocol spec](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md)
  — the wire contract (source of truth, lives in
  [`synadia-ai/nats-agent-sdk-docs`](https://github.com/synadia-ai/nats-agent-sdk-docs)).
- [`docs/protocol-mapping.md`](docs/protocol-mapping.md) — every SDK call
  mapped to its spec section; for auditors and other-SDK implementers.
- [`examples/README.md`](examples/README.md) — tour of the runnable
  demos under `examples/`.
- [`CHANGELOG.md`](CHANGELOG.md) — release notes and migration guidance.
- [`CLAUDE.md`](CLAUDE.md) — project context and engineering conventions.

## Development

```bash
uv sync                              # install
uv run ruff check . && uv run ruff format --check . && uv run mypy src tests examples && uv run pytest
```

Integration tests spawn a real `nats-server` per session and record wire
evidence under `tests/_evidence/<test-nodeid>/`. Cross-SDK interop tests
(`tests/test_interop_e2e.py`) additionally spawn the TypeScript
reference agent via `bun`; they skip cleanly if `bun` or the sibling
`../typescript/` checkout isn't present.

## License

Apache-2.0. See [LICENSE](LICENSE).

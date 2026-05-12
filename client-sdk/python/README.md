# synadia-ai-agents

Python **client** SDK for the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md).
Discover protocol-compliant agents over NATS and prompt them with
streamed typed responses.

**Hosting an agent (Hermes / claude-code / openclaw / pi)?** That side
of the protocol now ships separately as
[`synadia-ai-agent-service`](../../agent-sdk/python/) (import
`synadia_ai.agent_service`). It depends on this package for the
shared wire primitives — install both when authoring an agent
harness.

**Cross-SDK parity with the [TypeScript SDK](https://github.com/synadia-ai/synadia-agents/tree/main/client-sdk/typescript)**
is tracked in [`tests/test_interop_e2e.py`](tests/test_interop_e2e.py).
Both SDKs declare `protocol_version = "0.3"` in service metadata, so the
test spawns the TS reference agent via `bun` and rounds-trips a prompt
through it. The test `pytest.skip`s cleanly when `bun` or the sibling
`../typescript/` checkout is missing — running the suite without TS
interop is fine for day-to-day work.

**Calling agents?** → [Quickstart - call an agent](#quickstart--call-an-agent).
**Hosting an agent?** → see [`synadia-ai-agent-service`](../../agent-sdk/python/).

## Installation

From this checkout (no published wheel yet):

```bash
uv pip install -e .
```

Once released on PyPI:

```bash
pip install synadia-ai-agents
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
any hosted NATS works too - see
[Connecting to NATS in production](#connecting-to-nats-in-production)
below.

## Quickstart - call an agent

The SDK doesn't open NATS connections — you build a
`nats.aio.client.Client` and hand it to `Agents`. That mirrors what
`Svcm(nc)`, `jetstream(nc)`, `Kvm(nc)` do, and lets one connection serve
JetStream, KV, services, and agents at once.

```python
import asyncio
import nats
from synadia_ai.agents import Agents, ResponseChunk, StatusChunk

async def main() -> None:
    nc = await nats.connect(servers="nats://127.0.0.1:4222")
    agents = Agents(nc=nc)
    try:
        found = await agents.discover()           # list[Agent], stall by default
        for a in found:
            print(f"{a.agent}/{a.owner}/{a.name} @ {a.prompt_subject}")

        # Each Agent is directly callable — no bind step.
        async for msg in found[0].prompt("hello"):
            if isinstance(msg, ResponseChunk):
                print(msg.text, end="")
            elif isinstance(msg, StatusChunk) and msg.status == "done":
                print()
    finally:
        await agents.close()                      # SDK state only
        await nc.close()                          # caller owns this

asyncio.run(main())
```

## API matrix

| Symbol | Lives in | Purpose |
| --- | --- | --- |
| `Agents` | [`agents.py`](src/synadia_ai/agents/agents.py) | Caller-side entry point. Construct with `nc=`; owns the heartbeat wildcard sub. |
| `Agent` | [`agent.py`](src/synadia_ai/agents/agent.py) | Live handle from `Agents.discover()`. `.prompt()` is the one method that does I/O. |
| `AgentInfo` | [`discovery.py`](src/synadia_ai/agents/discovery.py) | Pure-data record (parsed `$SRV.INFO` per §4.3). What `build_agent_info()` returns. |
| `Liveness` | [`heartbeat.py`](src/synadia_ai/agents/heartbeat.py) | Frozen snapshot from `Agents.liveness(instance_id)`. |
| `load_context_options` | [`context.py`](src/synadia_ai/agents/context.py) | Resolve a `nats` CLI context into kwargs for `nats.connect(...)`. |
| `AgentService` | [`synadia-ai-agent-service`](../../agent-sdk/python/) | Server-side; ships in a separate distribution. Import from `synadia_ai.agent_service`. |

## Mid-stream queries

Agent handlers can pause their response stream to ask the caller a
question (permission prompt, clarification, menu selection):

```python
async for msg in agent.prompt("do the thing"):
    if isinstance(msg, Query):
        await msg.reply("yes")
    else:
        print(msg)     # ResponseChunk / StatusChunk
```

Server-side, the handler asks via `stream.ask(...)` — see
[`synadia-ai-agent-service`](../../agent-sdk/python/) for the host-side
API.

## Try the examples

Six runnable client-side demos live under
[`examples/`](examples/README.md). They talk to the reference agent
which now ships with `synadia-ai-agent-service` at
[`agent-sdk/python/examples/_reference_agent.py`](../../agent-sdk/python/examples/_reference_agent.py).
The ritual to see the SDKs work end-to-end:

```shell
# terminal 1 — start the reference agent (from the agent-sdk dist)
uv run --directory ../../agent-sdk/python python examples/_reference_agent.py \
  --url nats://127.0.0.1:4222

# terminal 2 — discover and prompt (from this dist)
uv run python examples/01-discover.py --url nats://127.0.0.1:4222
uv run python examples/02-prompt-text.py --url nats://127.0.0.1:4222 "hello"
```

See [`examples/README.md`](examples/README.md) for the full tour.

## Connecting to NATS in production

For [Synadia Cloud](https://www.synadia.com/cloud/) or any self-hosted
NATS that needs credentials, JWTs, or a non-default URL, use a `nats`
CLI context and load its kwargs into `nats.connect`:

```python
import nats
from synadia_ai.agents import Agents, load_context_options

nc = await nats.connect(**load_context_options("prod"))
agents = Agents(nc=nc)
```

`load_context_options(...)` reads
`~/.config/nats/context/<name>.json` — URL, creds file, token,
user/password, inbox prefix are all honored. See
[`CLAUDE.md`](CLAUDE.md#connecting-to-nats) for the full field-by-field
table (including which NATS-context fields are not yet supported and
fail fast rather than silently).

## Hosting an agent

The agent-host surface (`AgentService`, `PromptStream`,
`PromptHandler`, the heartbeat publisher) ships separately as
[`synadia-ai-agent-service`](../../agent-sdk/python/) — install that
package alongside this one when authoring an agent harness, and
import the host classes from `synadia_ai.agent_service`. The shared
wire types (`Envelope`, `Attachment`, error classes,
`HeartbeatPayload`, `AgentSubject`, the discovery constants) stay in
this package and continue to import from `synadia_ai.agents`.

Probe a running agent with the `nats` CLI (subjects are verb-first
per protocol v0.3):

```bash
nats micro list                                          # see "agents"
nats req  agents.prompt.demo.alice.worker-1 "hello" \
  --replies=0 --reply-timeout=30s --timeout=60s          # prompt it (see docs/using-nats-cli.md)
nats req  agents.status.demo.alice.worker-1 ""           # heartbeat-shaped status reply
nats sub  "agents.hb.demo.alice.worker-1"                # watch heartbeats
```

## Documentation

- [Synadia Agent Protocol for NATS spec](https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md)
  - the wire contract (source of truth, lives in
  [`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs)).
- [`docs/protocol-mapping.md`](docs/protocol-mapping.md) - every SDK call
  mapped to its spec section; for auditors and other-SDK implementers.
- [`examples/README.md`](examples/README.md) - tour of the runnable
  demos under `examples/`.
- [`CHANGELOG.md`](CHANGELOG.md) - release notes and migration guidance.
- [`CLAUDE.md`](CLAUDE.md) - project context and engineering conventions.

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

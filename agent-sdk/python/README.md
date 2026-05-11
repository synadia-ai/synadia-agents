# synadia-ai-agent-service

Python **agent-host** SDK for the [Synadia Agent Protocol for NATS](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md).
Embed `AgentService` in a Python agent harness (Hermes-style,
claude-code, openclaw, pi, …) to register a spec-compliant agent on a
NATS bus.

> **Calling agents (rather than hosting them)?** → use the sibling
> [`synadia-ai-agents`](../../client-sdk/python/) package
> (`from synadia_ai.agents import Agents, …`). This package depends
> on it for the shared wire primitives.

## Install

From a checkout (no published wheel yet):

```bash
uv pip install -e ../../client-sdk/python
uv pip install -e .
```

When both packages are on PyPI, plain `pip install
synadia-ai-agent-service` will pull `synadia-ai-agents>=0.6`
automatically.

## Quickstart — host an agent

```python
import asyncio
import nats
from synadia_ai.agents import Envelope                       # shared wire types
from synadia_ai.agent_service import AgentService, PromptStream

async def echo(envelope: Envelope, stream: PromptStream) -> None:
    await stream.send(f"echo: {envelope.prompt}")

async def main() -> None:
    nc = await nats.connect(servers="nats://127.0.0.1:4222")
    service = AgentService(
        agent="demo",            # your harness identifier (§2: lowercase + hyphens)
        owner="alice",           # operator / account (§2)
        session_name="worker-1", # 5th subject token / session this instance serves
        nc=nc,
        description="demo echo agent",
    )
    service.on_prompt(echo)
    await service.start()
    try:
        await asyncio.Event().wait()   # run until Ctrl-C
    finally:
        await service.stop()
        await nc.close()

asyncio.run(main())
```

A spec-compliant runnable echo agent ships at
[`examples/_reference_agent.py`](examples/_reference_agent.py) — used
both as the test harness for the client-side numbered demos in
`../../client-sdk/python/examples/` and as the wire-compat counterparty
for cross-SDK interop.

## Where things live

- This package — `synadia_ai.agent_service`: `AgentService`,
  `PromptStream`, `PromptHandler`, the heartbeat publisher loop,
  the status endpoint handler, and the reference agent.
- Sibling package — `synadia_ai.agents` (the
  [client SDK](../../client-sdk/python/)): the shared wire primitives
  (`Envelope`, `Attachment`, `HeartbeatPayload`, `AgentSubject`,
  error classes, discovery constants, `load_context_options`,
  `parse_nats_url`).

## Documentation

- [Root README](../../README.md) — protocol overview and monorepo
  layout.
- [`synadia-ai-agents`](../../client-sdk/python/) — the client surface
  this package depends on.
- [Synadia Agent Protocol for NATS spec](https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md)
  — wire-level source of truth.
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.
- [`CLAUDE.md`](CLAUDE.md) — project context and engineering
  conventions.

## Development

```bash
uv sync
uv run ruff check . && uv run ruff format --check . && uv run mypy src tests examples && uv run pytest
```

Integration tests spawn a real `nats-server` per session and record
wire evidence under `tests/_evidence/<test-nodeid>/`. The local
`[tool.uv.sources]` override resolves `synadia-ai-agents` to the
sibling client-sdk checkout, so no PyPI publish is required for CI to
pass.

## License

Apache-2.0. See [LICENSE](LICENSE).

"""End-to-end verification that caller-supplied ``session`` labels ride
the request envelope and arrive verbatim on the agent side (§5.1).

Session-aware harnesses (Hermes, pi, ...) rely on this: the label is a
caller-owned conversation pin, threaded through the SDK unchanged. Tests
cover the three supported entry paths:

- ``remote.prompt("text", session="s")`` — bare string + kwarg.
- ``remote.prompt(Envelope(prompt=..., session="s"))`` — envelope carries it.
- ``remote.prompt(Envelope(prompt=..., session="a"), session="b")`` —
  explicit kwarg wins (principle of least surprise).

The agent handler echoes the received session as part of its response so
the test can assert what actually landed on the wire — not just what we
encoded before publish.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

import pytest
import pytest_asyncio

from natsagent import (
    Agent,
    Client,
    Envelope,
    PromptStream,
    ResponseChunk,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"
OWNER = "pytest"
NAME = "session-echo"
HEARTBEAT_INTERVAL_S = 30


async def _echo_session(envelope: Envelope, stream: PromptStream) -> None:
    """Emit a JSON blob reporting the received session, so the caller
    can assert against what the agent actually parsed off the wire."""
    payload = json.dumps({"prompt": envelope.prompt, "session": envelope.session})
    await stream.send(payload)


@pytest_asyncio.fixture
async def session_agent(nc: NATSClient) -> AsyncIterator[Agent]:
    agent = Agent(
        agent=AGENT,
        owner=OWNER,
        name=NAME,
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    agent.on_prompt(_echo_session)
    await agent.start()
    try:
        yield agent
    finally:
        await agent.stop()


async def _single_response(remote_stream: AsyncIterator[object]) -> dict[str, object]:
    chunks: list[ResponseChunk] = []
    async for msg in remote_stream:
        assert isinstance(msg, ResponseChunk), f"unexpected chunk: {type(msg).__name__}"
        chunks.append(msg)
    assert len(chunks) == 1
    result = json.loads(chunks[0].text)
    assert isinstance(result, dict)
    return result


@pytest.mark.asyncio
async def test_session_kwarg_on_bare_string(
    nc: NATSClient, session_agent: Agent, evidence: EvidenceRecorder
) -> None:
    client = Client(nc=nc)
    await client.start()
    try:
        remote = client.bind(session_agent.subject.inbox)
        echoed = await _single_response(remote.prompt("hello", session="mychat", timeout=5.0))
        evidence.write_json("echo.json", echoed)
        assert echoed == {"prompt": "hello", "session": "mychat"}
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_session_omitted_when_not_passed(nc: NATSClient, session_agent: Agent) -> None:
    """Session-less callers must see ``None`` on the agent side — the
    field is absent on the wire (``exclude_none=True``) and decodes back
    to ``None``."""
    client = Client(nc=nc)
    await client.start()
    try:
        remote = client.bind(session_agent.subject.inbox)
        echoed = await _single_response(remote.prompt("hi", timeout=5.0))
        assert echoed == {"prompt": "hi", "session": None}
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_session_on_envelope_preserved(nc: NATSClient, session_agent: Agent) -> None:
    client = Client(nc=nc)
    await client.start()
    try:
        remote = client.bind(session_agent.subject.inbox)
        env = Envelope(prompt="from envelope", session="envelope-session")
        echoed = await _single_response(remote.prompt(env, timeout=5.0))
        assert echoed == {"prompt": "from envelope", "session": "envelope-session"}
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_kwarg_overrides_envelope_session(nc: NATSClient, session_agent: Agent) -> None:
    """Principle of least surprise — caller's kwarg is the fresher intent."""
    client = Client(nc=nc)
    await client.start()
    try:
        remote = client.bind(session_agent.subject.inbox)
        env = Envelope(prompt="both set", session="from-envelope")
        echoed = await _single_response(remote.prompt(env, session="from-kwarg", timeout=5.0))
        assert echoed == {"prompt": "both set", "session": "from-kwarg"}
    finally:
        await client.stop()

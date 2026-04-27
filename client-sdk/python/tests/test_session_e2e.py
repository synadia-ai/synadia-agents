"""End-to-end verification that caller-supplied ``session`` labels ride
the request envelope and arrive verbatim on the agent side (§5.1).

Session-aware harnesses (Hermes, pi, ...) rely on this: the label is a
caller-owned conversation pin, threaded through the SDK unchanged. Tests
cover the three supported entry paths:

- ``agent.prompt("text", session="s")`` — bare string + kwarg.
- ``agent.prompt(Envelope(prompt=..., session="s"))`` — envelope carries it.
- ``agent.prompt(Envelope(prompt=..., session="a"), session="b")`` —
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

from synadia_ai.agents import (
    Agent,
    Agents,
    AgentService,
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
async def session_service(nc: NATSClient) -> AsyncIterator[AgentService]:
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name=NAME,
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    service.on_prompt(_echo_session)
    await service.start()
    try:
        yield service
    finally:
        await service.stop()


async def _single_response(remote_stream: AsyncIterator[object]) -> dict[str, object]:
    chunks: list[ResponseChunk] = []
    async for msg in remote_stream:
        assert isinstance(msg, ResponseChunk), f"unexpected chunk: {type(msg).__name__}"
        chunks.append(msg)
    assert len(chunks) == 1
    result = json.loads(chunks[0].text)
    assert isinstance(result, dict)
    return result


async def _agent_for(agents: Agents, service: AgentService) -> Agent:
    found = await agents.discover(timeout=1.0)
    return next(a for a in found if a.prompt_subject == service.subject.inbox)


@pytest.mark.asyncio
async def test_session_kwarg_on_bare_string(
    nc: NATSClient, session_service: AgentService, evidence: EvidenceRecorder
) -> None:
    agents = Agents(nc=nc)
    try:
        agent = await _agent_for(agents, session_service)
        echoed = await _single_response(agent.prompt("hello", session="mychat", timeout=5.0))
        evidence.write_json("echo.json", echoed)
        assert echoed == {"prompt": "hello", "session": "mychat"}
    finally:
        await agents.close()


@pytest.mark.asyncio
async def test_session_omitted_when_not_passed(
    nc: NATSClient, session_service: AgentService
) -> None:
    """Session-less callers must see ``None`` on the agent side — the
    field is absent on the wire (``exclude_none=True``) and decodes back
    to ``None``."""
    agents = Agents(nc=nc)
    try:
        agent = await _agent_for(agents, session_service)
        echoed = await _single_response(agent.prompt("hi", timeout=5.0))
        assert echoed == {"prompt": "hi", "session": None}
    finally:
        await agents.close()


@pytest.mark.asyncio
async def test_session_on_envelope_preserved(nc: NATSClient, session_service: AgentService) -> None:
    agents = Agents(nc=nc)
    try:
        agent = await _agent_for(agents, session_service)
        env = Envelope(prompt="from envelope", session="envelope-session")
        echoed = await _single_response(agent.prompt(env, timeout=5.0))
        assert echoed == {"prompt": "from envelope", "session": "envelope-session"}
    finally:
        await agents.close()


@pytest.mark.asyncio
async def test_kwarg_overrides_envelope_session(
    nc: NATSClient, session_service: AgentService
) -> None:
    """Principle of least surprise — caller's kwarg is the fresher intent."""
    agents = Agents(nc=nc)
    try:
        agent = await _agent_for(agents, session_service)
        env = Envelope(prompt="both set", session="from-envelope")
        echoed = await _single_response(agent.prompt(env, session="from-kwarg", timeout=5.0))
        assert echoed == {"prompt": "both set", "session": "from-kwarg"}
    finally:
        await agents.close()

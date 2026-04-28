"""Log-record coverage for the silent I/O paths in the caller surface.

Each test exercises a real NATS server (same fixture setup as the other
e2e tests) and asserts that the expected log record appears on the
``synadia_ai.agents.*`` loggers. Wire traces land in
``tests/_evidence/<nodeid>/messages.jsonl`` via the session-scoped
``EvidenceRecorder`` for eyeball review.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import pytest

from synadia_ai.agents import Agents, AgentService, Envelope, PromptStream
from synadia_ai.agents.errors import ProtocolError

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"
OWNER = "pytest"
# Long enough that no heartbeat fires during the sub-second observability tests.
HEARTBEAT_INTERVAL_S = 30


def _has_record(caplog: pytest.LogCaptureFixture, level: int, needle: str) -> bool:
    return any(
        r.name.startswith("synadia_ai.agents") and r.levelno == level and needle in r.getMessage()
        for r in caplog.records
    )


async def test_ping_unknown_instance_returns_false(
    nc: NATSClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """``Agents.ping`` for an unknown instance_id returns ``False`` and logs at debug."""
    caplog.set_level(logging.DEBUG, logger="synadia_ai.agents.discovery")
    agents = Agents(nc=nc)
    try:
        assert await agents.ping("nonexistent-instance", timeout=0.5) is False
    finally:
        await agents.close()
    # Either path (timeout or no-responders) logs at debug.
    assert _has_record(caplog, logging.DEBUG, "ping("), (
        f"expected debug log on ping; saw: "
        f"{[(r.levelname, r.name, r.getMessage()) for r in caplog.records]}"
    )


async def test_stream_stall_logs_warning(
    nc: NATSClient,
    evidence: EvidenceRecorder,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Prompting an inbox that no agent serves stalls the stream and emits a
    ``warning`` record against the reply subject. Publishes go nowhere,
    ``sub.next_msg`` times out, ``ProtocolError`` is raised.
    """
    del evidence

    # Stand up an agent so discovery succeeds, then stop it so the
    # subject has no subscribers — prompting the stale handle stalls.
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="observability-stall",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )

    async def _noop(envelope: Envelope, stream: PromptStream) -> None:
        del envelope, stream

    service.on_prompt(_noop)
    await service.start()

    caplog.set_level(logging.WARNING, logger="synadia_ai.agents.agent")
    agents = Agents(nc=nc)
    try:
        found = await agents.discover(timeout=1.0)
        agent = next(a for a in found if a.prompt_subject == service.subject.inbox)
        # Stop the service so the prompt has no responder.
        await service.stop()

        with pytest.raises(ProtocolError, match="stream stalled"):
            async for _ in agent.prompt("hi", timeout=0.2):
                pass
    finally:
        await agents.close()

    assert _has_record(caplog, logging.WARNING, "stream stalled on"), (
        f"expected warning log on stream stall; saw: "
        f"{[(r.levelname, r.name, r.getMessage()) for r in caplog.records]}"
    )


async def test_service_error_logs_warning(
    nc: NATSClient,
    evidence: EvidenceRecorder,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A handler exception triggers the §9.3 error frame — the client surface
    raises ``ProtocolError`` and emits a ``warning`` record describing the
    error code and reply subject.
    """
    del evidence

    async def _boom(envelope: Envelope, stream: PromptStream) -> None:
        raise RuntimeError("kaboom")

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="observability-raises",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    service.on_prompt(_boom)
    await service.start()

    try:
        caplog.set_level(logging.WARNING, logger="synadia_ai.agents.agent")
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)
            with pytest.raises(ProtocolError, match="500"):
                async for _ in agent.prompt("trigger", timeout=5.0):
                    pass
        finally:
            await agents.close()
    finally:
        await service.stop()

    assert _has_record(caplog, logging.WARNING, "service error on"), (
        f"expected warning log on service error; saw: "
        f"{[(r.levelname, r.name, r.getMessage()) for r in caplog.records]}"
    )

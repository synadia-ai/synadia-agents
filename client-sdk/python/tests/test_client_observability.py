"""Log-record coverage for the three silent I/O paths in ``Client``.

Each test exercises a real NATS server (same fixture setup as the other
e2e tests) and asserts that the expected log record appears on the
``natsagent.client`` logger. Wire traces land in
``tests/_evidence/<nodeid>/messages.jsonl`` via the session-scoped
``EvidenceRecorder`` for eyeball review.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import pytest

from natsagent import Agent, Client, Envelope, PromptStream
from natsagent.errors import ProtocolError

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"
OWNER = "pytest"
# Long enough that no heartbeat fires during the sub-second observability tests.
HEARTBEAT_INTERVAL_S = 30


def _has_record(caplog: pytest.LogCaptureFixture, level: int, needle: str) -> bool:
    return any(
        r.name.startswith("natsagent") and r.levelno == level and needle in r.getMessage()
        for r in caplog.records
    )


async def test_ping_no_agent_logs_debug_and_returns_false(
    nc: NATSClient,
    evidence: EvidenceRecorder,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """``Client.ping`` with subscribers present but no responder returns
    ``False`` and logs the timeout path. The ``evidence`` fixture's
    wildcard subscription on ``$SRV.>`` is itself a subscriber, so the
    broker does NOT report ``no_responders`` — the request waits until
    the configured timeout and hits the ``TimeoutError`` branch.
    """
    del evidence  # subscription captures wire trace via the fixture side-effect

    caplog.set_level(logging.DEBUG, logger="natsagent.client")
    client = Client(nc=nc)
    await client.start()
    try:
        assert await client.ping(timeout=0.2) is False
    finally:
        await client.stop()

    assert _has_record(caplog, logging.DEBUG, "no compliant agent responded"), (
        f"expected debug log on ping timeout; saw: "
        f"{[(r.levelname, r.name, r.getMessage()) for r in caplog.records]}"
    )


async def test_ping_no_responders_logs_debug_and_returns_false(
    nc: NATSClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Same outcome as above (``False`` + debug record), but via the
    ``NoRespondersError`` path — the broker advertises ``no_responders``
    to nats-py when zero subscribers match a request. This test does NOT
    request the ``evidence`` fixture so the ping actually hits that
    header-driven fast-fail instead of waiting out the timeout.
    """
    caplog.set_level(logging.DEBUG, logger="natsagent.client")
    client = Client(nc=nc)
    try:
        # NOTE: do not call `client.start()` — the heartbeat wildcard sub
        # would also count as interest on a different subject tree, but the
        # ping target `$SRV.PING.agents` still has zero subscribers
        # so this is belt-and-braces for a deterministic no-responders path.
        assert await client.ping(timeout=2.0) is False
    finally:
        await client.stop()

    assert _has_record(caplog, logging.DEBUG, "no responders"), (
        f"expected no-responders debug log; saw: "
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

    caplog.set_level(logging.WARNING, logger="natsagent.client")
    client = Client(nc=nc)
    remote = client.bind(f"agents.{AGENT}.{OWNER}.noreply")
    with pytest.raises(ProtocolError, match="stream stalled"):
        async for _ in remote.prompt("hi", timeout=0.2):
            pass

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

    agent = Agent(
        agent=AGENT,
        owner=OWNER,
        name="observability-raises",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    agent.on_prompt(_boom)
    await agent.start()

    try:
        caplog.set_level(logging.WARNING, logger="natsagent.client")
        client = Client(nc=nc)
        remote = client.bind(agent.subject.inbox)
        with pytest.raises(ProtocolError, match="500"):
            async for _ in remote.prompt("trigger", timeout=5.0):
                pass
    finally:
        await agent.stop()

    assert _has_record(caplog, logging.WARNING, "service error on"), (
        f"expected warning log on service error; saw: "
        f"{[(r.levelname, r.name, r.getMessage()) for r in caplog.records]}"
    )

"""End-to-end tests for :meth:`Agents.discover`.

Covers:

- Stall strategy (default) — returns ≥ first reply but ≤ ``max_wait``.
- Timer strategy (``timeout=`` set) — returns within a deterministic window.
- Identity ``filter=`` — excludes non-matches.
- Empty bus — returns ``[]`` without raising.

Wire evidence is written to ``tests/_evidence/<nodeid>/messages.jsonl``
via the session-scoped :class:`EvidenceRecorder` so reviewers can verify
the ``$SRV.INFO.agents`` request + response trace by eye.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import pytest

from synadia_ai.agents import (
    DEFAULT_DISCOVER_MAX_WAIT_S,
    Agents,
    AgentService,
    DiscoverFilter,
    Envelope,
    PromptStream,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"
OWNER = "pytest"
HEARTBEAT_INTERVAL_S = 30  # Long enough that no beacon fires during a discover() window.


async def _noop(envelope: Envelope, stream: PromptStream) -> None:
    del envelope, stream


async def _start_service(nc: NATSClient, name: str, **kwargs: object) -> AgentService:
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name=name,
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
        **kwargs,  # type: ignore[arg-type]
    )
    service.on_prompt(_noop)
    await service.start()
    return service


@pytest.fixture
async def two_services(nc: NATSClient) -> AsyncIterator[tuple[AgentService, AgentService]]:
    a = await _start_service(nc, "discover-a")
    b = await _start_service(nc, "discover-b")
    try:
        yield (a, b)
    finally:
        await a.stop()
        await b.stop()


async def test_discover_stall_default_returns_within_max_wait(
    nc: NATSClient,
    two_services: tuple[AgentService, AgentService],
    evidence: EvidenceRecorder,
) -> None:
    """Stall strategy returns at least the first reply, no later than max_wait."""
    del evidence  # ensures wire trace is captured under the test's evidence dir
    a, b = two_services
    agents = Agents(nc=nc)
    try:
        loop = asyncio.get_event_loop()
        start = loop.time()
        found = await agents.discover()  # default = stall
        elapsed = loop.time() - start
        # stall window should bound this to roughly the absolute cap.
        assert elapsed <= DEFAULT_DISCOVER_MAX_WAIT_S + 0.5, (
            f"stall took longer than safety cap: {elapsed}s"
        )
        subjects = {x.prompt_subject for x in found}
        assert a.subject.prompt in subjects
        assert b.subject.prompt in subjects
        # v0.3 §-TBD: every discovered agent now exposes both `prompt` and
        # `status` endpoints with the new verb-first subjects.
        for info in found:
            endpoint_names = {ep.name for ep in info.endpoints}
            assert {"prompt", "status"} <= endpoint_names, (
                f"endpoints missing prompt/status: {endpoint_names}"
            )
            status_ep = next(ep for ep in info.endpoints if ep.name == "status")
            assert status_ep.subject.startswith("agents.status.")
    finally:
        await agents.close()


async def test_discover_with_timeout_uses_timer_strategy(
    nc: NATSClient,
    two_services: tuple[AgentService, AgentService],
) -> None:
    """Setting ``timeout=`` switches to the timer strategy — bounded wait."""
    a, b = two_services
    agents = Agents(nc=nc)
    try:
        loop = asyncio.get_event_loop()
        start = loop.time()
        found = await agents.discover(timeout=1.0)
        elapsed = loop.time() - start
        # Timer strategy waits the full window (we tolerate a generous slack).
        assert 0.5 <= elapsed <= 2.5, f"timer strategy out of window: {elapsed}s"
        subjects = {x.prompt_subject for x in found}
        assert a.subject.prompt in subjects
        assert b.subject.prompt in subjects
    finally:
        await agents.close()


async def test_discover_filter_excludes_non_matches(
    nc: NATSClient,
    two_services: tuple[AgentService, AgentService],
) -> None:
    """``filter=`` drops everything that doesn't AND-match every set field."""
    a, _ = two_services
    agents = Agents(nc=nc)
    try:
        found = await agents.discover(
            timeout=1.0,
            filter=DiscoverFilter(name="discover-a"),
        )
        names = [x.name for x in found]
        # Only the matching service makes it through.
        assert "discover-a" in names
        assert "discover-b" not in names
        assert any(x.prompt_subject == a.subject.prompt for x in found)
    finally:
        await agents.close()


async def test_discover_empty_bus_returns_empty_list(nc: NATSClient) -> None:
    """No agents registered — discover() returns ``[]`` without raising."""
    agents = Agents(nc=nc)
    try:
        found = await agents.discover(timeout=0.5)
        assert found == []
    finally:
        await agents.close()

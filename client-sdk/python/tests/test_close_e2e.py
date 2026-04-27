"""``Agents.close()`` interrupts an in-flight prompt stream within one tick.

Regression coverage for the close-event race fix in ``Agent._stream_prompt``:
without the fix, ``Agents.close()`` is only observed at the top of each
loop iteration — i.e. after ``sub.next_msg(timeout=...)`` either returns or
times out. For a stalled handler with a 60 s default inactivity timeout
this means teardown blocks for up to a minute. With the fix the close event
is raced against ``next_msg`` via ``asyncio.wait(..., FIRST_COMPLETED)``
and observed promptly.

The test stands up an agent whose handler never emits a chunk, kicks off a
prompt with a long inactivity timeout, schedules ``close()`` shortly after,
and asserts both the raised :class:`ProtocolError` and that the cancellation
returned in well under the inactivity budget.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import pytest

from natsagent import Agents, AgentService, Envelope, PromptStream
from natsagent.errors import ProtocolError

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


AGENT = "test"
OWNER = "pytest"
HEARTBEAT_INTERVAL_S = 30  # Long; this test runs sub-second.
STREAM_INACTIVITY_TIMEOUT_S = 30.0  # Big budget — the fix should beat it by ~30x.


async def _silent(envelope: Envelope, stream: PromptStream) -> None:
    """Handler that never emits any chunk — keeps the prompt stream stalled."""
    del envelope, stream
    # Block long enough that the inactivity timeout would fire if close()
    # were ignored mid-wait.
    await asyncio.sleep(STREAM_INACTIVITY_TIMEOUT_S * 2)


async def test_close_interrupts_in_flight_prompt(nc: NATSClient) -> None:
    """``Agents.close()`` while ``next_msg`` is blocked must raise within one tick."""
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name="close-mid-stream",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    service.on_prompt(_silent)
    await service.start()

    agents = Agents(nc=nc)
    try:
        found = await agents.discover(timeout=1.0)
        agent = next(a for a in found if a.prompt_subject == service.subject.inbox)

        async def _close_after(delay_s: float) -> None:
            await asyncio.sleep(delay_s)
            await agents.close()

        loop = asyncio.get_running_loop()
        closer = asyncio.create_task(_close_after(0.2))
        start = loop.time()
        with pytest.raises(ProtocolError, match="owning Agents is closed"):
            async for _ in agent.prompt("never answered", timeout=STREAM_INACTIVITY_TIMEOUT_S):
                pass
        elapsed = loop.time() - start
        await closer

        # The fix promises close is observed within one event-loop tick of
        # `agents.close()`. Allow generous slack for CI noise but stay an
        # order of magnitude below the inactivity budget so a regression
        # (close observed only after `next_msg` resolves) fails the test.
        assert elapsed < STREAM_INACTIVITY_TIMEOUT_S / 5, (
            f"close took {elapsed:.2f}s — close_event was not observed mid-stream"
        )
    finally:
        # `agents.close()` was already called inside the test body; this
        # second call exercises the idempotent path.
        await agents.close()
        await service.stop()

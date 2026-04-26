"""End-to-end tests for per-request keep-alive ack emission.

Regression-guards the §6.4 keep-alive behaviour the TS reference harnesses
implement (`agents/pi/`, `agents/claude-code/`, `agents/openclaw/`):
while a handler is running, the agent emits ``{"type":"status","data":"ack"}``
every ``keepalive_interval_s`` so callers using a stream inactivity timeout
don't fire on slow handlers.

Three integration scenarios:

* **default-on, slow handler** — at least one ack appears in the streamed
  chunks.
* **disabled, slow handler** — no ack, even when the handler runs longer
  than the (non-)interval.
* **default-on, fast handler** — no ack (the loop's first emit is ``after``
  the first ``asyncio.sleep``, so a sub-interval handler never trips it).

Plus a unit test guarding the constructor's input validation.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

import pytest

from natsagent import (
    Agent,
    Client,
    Envelope,
    PromptStream,
    ResponseChunk,
    StatusChunk,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"
OWNER = "pytest"


def _make_slow_handler(duration_s: float) -> object:
    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        del envelope
        await asyncio.sleep(duration_s)
        await stream.send("done")

    return handler


@pytest.mark.parametrize("bad_value", [0, -1, -0.1])
def test_constructor_rejects_non_positive_keepalive(bad_value: float) -> None:
    """`keepalive_interval_s` must be > 0 or ``None``; zero/negative is a config bug."""
    # Pass a sentinel for ``nc`` — construction-time validation runs before
    # any I/O, so the live client fixture isn't needed here.
    with pytest.raises(ValueError, match="keepalive_interval_s"):
        Agent(
            agent=AGENT,
            owner=OWNER,
            name="cfg",
            nc=object(),  # type: ignore[arg-type]
            keepalive_interval_s=bad_value,
        )


@pytest.mark.asyncio
async def test_keepalive_emits_ack_during_slow_handler(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """A handler that runs longer than the interval triggers ≥1 ack chunk."""
    interval = 0.1
    handler_duration = 0.45  # ~4 intervals — comfortably more than one tick

    agent = Agent(
        agent=AGENT,
        owner=OWNER,
        name="slow-default",
        nc=nc,
        keepalive_interval_s=interval,
    )
    agent.on_prompt(_make_slow_handler(handler_duration))  # type: ignore[arg-type]
    await agent.start()

    try:
        client = Client(nc=nc)
        await client.start()
        try:
            found = await client.discover(timeout=1.0)
            discovered = next(d for d in found if d.inbox == agent.subject.inbox)
            remote = client.bind(discovered)

            received: list[ResponseChunk | StatusChunk] = []
            async for msg in remote.prompt("hi", timeout=5.0):
                assert isinstance(msg, ResponseChunk | StatusChunk), (
                    f"unexpected chunk type: {type(msg).__name__}"
                )
                received.append(msg)
        finally:
            await client.stop()

        evidence.write_jsonl(
            "chunks.jsonl",
            [json.loads(chunk.model_dump_json()) for chunk in received],
        )

        acks = [c for c in received if isinstance(c, StatusChunk) and c.status == "ack"]
        responses = [c for c in received if isinstance(c, ResponseChunk)]
        assert len(acks) >= 1, f"expected ≥1 keep-alive ack, saw chunks: {received!r}"
        assert any(r.text == "done" for r in responses), (
            f"expected the handler's final 'done' response, saw: {received!r}"
        )
    finally:
        await agent.stop()


@pytest.mark.asyncio
async def test_keepalive_disabled_emits_no_ack(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """`keepalive_interval_s=None` suppresses keep-alive even on slow handlers."""
    handler_duration = 0.3

    agent = Agent(
        agent=AGENT,
        owner=OWNER,
        name="slow-disabled",
        nc=nc,
        keepalive_interval_s=None,
    )
    agent.on_prompt(_make_slow_handler(handler_duration))  # type: ignore[arg-type]
    await agent.start()

    try:
        client = Client(nc=nc)
        await client.start()
        try:
            found = await client.discover(timeout=1.0)
            discovered = next(d for d in found if d.inbox == agent.subject.inbox)
            remote = client.bind(discovered)

            received: list[ResponseChunk | StatusChunk] = []
            async for msg in remote.prompt("hi", timeout=5.0):
                assert isinstance(msg, ResponseChunk | StatusChunk), (
                    f"unexpected chunk type: {type(msg).__name__}"
                )
                received.append(msg)
        finally:
            await client.stop()

        evidence.write_jsonl(
            "chunks.jsonl",
            [json.loads(chunk.model_dump_json()) for chunk in received],
        )
        acks = [c for c in received if isinstance(c, StatusChunk) and c.status == "ack"]
        assert acks == [], f"expected no keep-alive acks when disabled, got: {acks!r}"
    finally:
        await agent.stop()


@pytest.mark.asyncio
async def test_keepalive_skips_ack_for_fast_handler(
    nc: NATSClient,
) -> None:
    """A handler that completes within one interval never trips the keep-alive."""
    interval = 1.0  # well above the handler's duration

    async def fast_handler(envelope: Envelope, stream: PromptStream) -> None:
        del envelope
        await stream.send("instant")

    agent = Agent(
        agent=AGENT,
        owner=OWNER,
        name="fast",
        nc=nc,
        keepalive_interval_s=interval,
    )
    agent.on_prompt(fast_handler)
    await agent.start()

    try:
        client = Client(nc=nc)
        await client.start()
        try:
            found = await client.discover(timeout=1.0)
            discovered = next(d for d in found if d.inbox == agent.subject.inbox)
            remote = client.bind(discovered)

            received: list[ResponseChunk | StatusChunk] = []
            async for msg in remote.prompt("hi", timeout=5.0):
                assert isinstance(msg, ResponseChunk | StatusChunk)
                received.append(msg)
        finally:
            await client.stop()

        acks = [c for c in received if isinstance(c, StatusChunk) and c.status == "ack"]
        assert acks == [], f"fast handler must not emit any keep-alive acks, got: {acks!r}"
    finally:
        await agent.stop()

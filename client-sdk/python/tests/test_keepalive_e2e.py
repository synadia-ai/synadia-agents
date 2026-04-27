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
    Agents,
    AgentService,
    Envelope,
    PromptHandler,
    PromptStream,
    ResponseChunk,
    StatusChunk,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"
OWNER = "pytest"


def _make_slow_handler(duration_s: float) -> PromptHandler:
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
        AgentService(
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

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name="slow-default",
        nc=nc,
        keepalive_interval_s=interval,
    )
    service.on_prompt(_make_slow_handler(handler_duration))
    await service.start()

    try:
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)

            received: list[ResponseChunk | StatusChunk] = []
            async for msg in agent.prompt("hi", timeout=5.0):
                assert isinstance(msg, ResponseChunk | StatusChunk), (
                    f"unexpected chunk type: {type(msg).__name__}"
                )
                received.append(msg)
        finally:
            await agents.close()

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
        await service.stop()


@pytest.mark.asyncio
async def test_keepalive_disabled_emits_no_ack(nc: NATSClient, evidence: EvidenceRecorder) -> None:
    """`keepalive_interval_s=None` suppresses keep-alive even on slow handlers."""
    handler_duration = 0.3

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name="slow-disabled",
        nc=nc,
        keepalive_interval_s=None,
    )
    service.on_prompt(_make_slow_handler(handler_duration))
    await service.start()

    try:
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)

            received: list[ResponseChunk | StatusChunk] = []
            async for msg in agent.prompt("hi", timeout=5.0):
                assert isinstance(msg, ResponseChunk | StatusChunk), (
                    f"unexpected chunk type: {type(msg).__name__}"
                )
                received.append(msg)
        finally:
            await agents.close()

        evidence.write_jsonl(
            "chunks.jsonl",
            [json.loads(chunk.model_dump_json()) for chunk in received],
        )
        acks = [c for c in received if isinstance(c, StatusChunk) and c.status == "ack"]
        assert acks == [], f"expected no keep-alive acks when disabled, got: {acks!r}"
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_keepalive_no_ack_between_error_frame_and_terminator(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """Regression-guard: ack chunks MUST NOT slip between error(500) and the §6.5 terminator.

    PR #20 reviewer surfaced a race: when the handler raises,
    ``await request.respond_error(...)`` yields to the event loop. If the
    keep-alive timer fires during that yield, the caller would observe
    ``error(500) → ack → terminator`` instead of ``error(500) → terminator``.
    Spec-compliant (terminator is still last) but undesirable. The fix
    cancels keep-alive *before* calling ``respond_error``; this test
    asserts that on the wire by subscribing to the reply inbox directly
    rather than going through the iterator (which raises on the error
    frame and so can't observe what comes after).
    """
    interval = 0.05  # very short, so multiple ticks fire during the handler
    handler_duration = 0.25  # ~5 intervals of opportunity to race

    async def raising_handler(envelope: Envelope, stream: PromptStream) -> None:
        del envelope, stream
        await asyncio.sleep(handler_duration)
        raise RuntimeError("intentional")

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name="raises",
        nc=nc,
        keepalive_interval_s=interval,
    )
    service.on_prompt(raising_handler)
    await service.start()

    try:
        # Subscribe to a fresh inbox before publishing so we don't miss any frames.
        reply_inbox = nc.new_inbox()
        sub = await nc.subscribe(reply_inbox)
        try:
            # The agent's prompt endpoint expects an envelope; a bare-string
            # request is promoted to {"prompt": "..."} per §5.3.
            await nc.publish(service.subject.inbox, b"hi", reply=reply_inbox)

            # Drain frames until we see the empty-body, headerless §6.5 terminator.
            frames: list[tuple[bytes, dict[str, str]]] = []
            deadline = asyncio.get_event_loop().time() + 5.0
            while asyncio.get_event_loop().time() < deadline:
                try:
                    msg = await sub.next_msg(timeout=1.0)
                except TimeoutError:
                    pytest.fail(f"no terminator within deadline; frames: {frames!r}")
                headers = dict(msg.headers or {})
                frames.append((msg.data, headers))
                # §6.5 terminator: empty body, NO headers.
                if msg.data == b"" and not headers:
                    break
            else:
                pytest.fail(f"loop exited without terminator; frames: {frames!r}")
        finally:
            await sub.unsubscribe()
    finally:
        await service.stop()

    evidence.write_jsonl(
        "frames.jsonl",
        [
            {"data": data.decode("utf-8", errors="replace"), "headers": headers}
            for data, headers in frames
        ],
    )

    # Find the index of the error frame and the terminator.
    error_idx = next(i for i, (_, h) in enumerate(frames) if "Nats-Service-Error-Code" in h)
    terminator_idx = len(frames) - 1
    assert frames[terminator_idx] == (b"", {}), (
        f"last frame must be the §6.5 terminator, got: {frames[terminator_idx]!r}"
    )
    # Every frame strictly between error and terminator must be empty (the
    # spec doesn't define what could legitimately go there; the keep-alive
    # ack is what we're guarding against).
    between = frames[error_idx + 1 : terminator_idx]
    assert between == [], (
        f"no frames may appear between error(500) and the §6.5 terminator; saw: {between!r}"
    )


@pytest.mark.asyncio
async def test_keepalive_skips_ack_for_fast_handler(
    nc: NATSClient,
) -> None:
    """A handler that completes within one interval never trips the keep-alive."""
    interval = 1.0  # well above the handler's duration

    async def fast_handler(envelope: Envelope, stream: PromptStream) -> None:
        del envelope
        await stream.send("instant")

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name="fast",
        nc=nc,
        keepalive_interval_s=interval,
    )
    service.on_prompt(fast_handler)
    await service.start()

    try:
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)

            received: list[ResponseChunk | StatusChunk] = []
            async for msg in agent.prompt("hi", timeout=5.0):
                assert isinstance(msg, ResponseChunk | StatusChunk)
                received.append(msg)
        finally:
            await agents.close()

        acks = [c for c in received if isinstance(c, StatusChunk) and c.status == "ack"]
        assert acks == [], f"fast handler must not emit any keep-alive acks, got: {acks!r}"
    finally:
        await service.stop()

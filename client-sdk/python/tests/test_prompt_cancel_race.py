"""Cancellation and teardown races on the interim mux-inbox prompt path.

Plan §race analysis covers a dozen-odd windows where a prompt can be
cancelled or torn down. These tests pin the load-bearing ones:

- :class:`Agents.close` mid-stream delivers a sentinel that unblocks the
  consumer within an event-loop tick, NOT after the inactivity timer.
- 50 concurrent prompts on the same shared mux see only their own
  chunks (no token cross-talk).
- :meth:`Agent.prompt` after :meth:`Agents.close` raises a clean error
  rather than silently registering an orphan token.

Each test uses a tiny in-process fake agent (a NATS subscription
callback) so the suite covers the whole client path — mux subscribe,
publish, queue dispatch, terminator detection — without depending on
the agent-sdk distribution.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator
from contextlib import aclosing
from types import MappingProxyType
from typing import TYPE_CHECKING, cast

import pytest

from synadia_ai.agents import (
    Agent,
    AgentInfo,
    Agents,
    AgentsClosedError,
    EndpointInfo,
    ProtocolError,
    ResponseChunk,
)
from synadia_ai.agents._mux import mux_for

if TYPE_CHECKING:
    from collections.abc import Callable

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.harness.evidence import EvidenceRecorder

    BgTasks = Callable[[asyncio.Task[object]], None]


PROMPT_SUBJECT = "agents.prompt.test-agent.pytest.cancel"


def _make_agent_info(prompt_subject: str) -> AgentInfo:
    prompt_endpoint = EndpointInfo(
        name="prompt",
        subject=prompt_subject,
        queue_group="agents",
        metadata=MappingProxyType({}),
        max_payload_bytes=None,
        attachments_ok=True,
    )
    return AgentInfo(
        instance_id="test-instance",
        agent="test-agent",
        owner="pytest",
        session_name="cancel",
        protocol_version="0.3",
        description="",
        version="0.0.0",
        metadata=MappingProxyType({"agent": "test-agent", "owner": "pytest"}),
        endpoints=(prompt_endpoint,),
        prompt_endpoint=prompt_endpoint,
    )


def _response_chunk_bytes(text: str) -> bytes:
    return json.dumps({"type": "response", "data": text}).encode("utf-8")


async def test_agents_close_during_live_stream_unblocks_promptly(
    nc: NATSClient, evidence: EvidenceRecorder, bg_tasks: BgTasks
) -> None:
    """A live consumer raises within ~50 ms of :meth:`Agents.close`, not on timeout."""

    async def trickle_agent(msg: Msg) -> None:
        async def emit() -> None:
            i = 0
            while True:
                await nc.publish(msg.reply, _response_chunk_bytes(f"trickle-{i}"))
                i += 1
                await asyncio.sleep(0.05)

        bg_tasks(asyncio.create_task(emit()))

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=trickle_agent)
    try:
        # Build an Agents that owns the mux, plus an Agent attached to it.
        agents = Agents(nc=nc)
        info = _make_agent_info(PROMPT_SUBJECT)
        agent = Agent(nc, info, close_event=agents.close_event)

        consume_started = asyncio.Event()
        close_fired_at: dict[str, float] = {}
        consume_unblocked_at: dict[str, float] = {}

        async def consume() -> None:
            consume_started.set()
            with pytest.raises(ProtocolError) as excinfo:
                # Use a long inactivity timeout so the failure path
                # MUST come from the close-sentinel, not from inactivity.
                async for _ in agent.prompt("hold open", timeout=60.0):
                    pass
            consume_unblocked_at["t"] = time.monotonic()
            assert "Agents is closed" in str(excinfo.value)

        consumer = asyncio.create_task(consume())
        await consume_started.wait()
        # Let the agent start emitting so the stream is genuinely live.
        await asyncio.sleep(0.15)
        close_fired_at["t"] = time.monotonic()
        await agents.close()
        await asyncio.wait_for(consumer, timeout=2.0)

        elapsed_ms = (consume_unblocked_at["t"] - close_fired_at["t"]) * 1000
        # Assert "promptly" — well under any inactivity deadline.
        assert elapsed_ms < 500, (
            f"close→unblock took {elapsed_ms:.1f} ms; expected <500 ms (mux sentinel path)"
        )
        evidence.write_json("close_latency.json", {"unblock_ms": elapsed_ms})
    finally:
        await sub.unsubscribe()


async def test_concurrent_prompts_isolated(
    nc: NATSClient, evidence: EvidenceRecorder, bg_tasks: BgTasks
) -> None:
    """50 concurrent prompts on the shared mux see ONLY their own chunks."""

    n_streams = 50
    chunks_per_stream = 5

    async def echo_agent(msg: Msg) -> None:
        # Each request body is the unique stream marker; echo it back.
        marker = msg.data.decode("utf-8")
        # Promote bare-string requests into the §5.3 envelope shape so
        # we know exactly what came in.
        try:
            envelope = json.loads(marker)
            payload_text = envelope.get("prompt", marker)
        except json.JSONDecodeError:
            payload_text = marker

        async def emit() -> None:
            for i in range(chunks_per_stream):
                await nc.publish(msg.reply, _response_chunk_bytes(f"{payload_text}#{i}"))
            await nc.publish(msg.reply, b"")  # terminator

        bg_tasks(asyncio.create_task(emit()))

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=echo_agent)
    try:
        agents = Agents(nc=nc)
        info = _make_agent_info(PROMPT_SUBJECT)
        agent = Agent(nc, info, close_event=agents.close_event)

        async def run_one(idx: int) -> list[str]:
            seen: list[str] = []
            async for chunk in agent.prompt(f"marker-{idx}"):
                if isinstance(chunk, ResponseChunk):
                    seen.append(chunk.text)
            return seen

        results = await asyncio.gather(*(run_one(i) for i in range(n_streams)))
        await agents.close()
    finally:
        await sub.unsubscribe()

    # Every stream sees exactly its own chunks in order — no cross-talk.
    for idx, seen in enumerate(results):
        expected = [f"marker-{idx}#{i}" for i in range(chunks_per_stream)]
        assert seen == expected, (
            f"stream {idx} cross-contaminated: expected {expected!r}, got {seen!r}"
        )
    evidence.write_json(
        "isolation.json",
        {"streams": n_streams, "chunks_per_stream": chunks_per_stream, "ok": True},
    )


async def test_cancel_during_iteration_unregisters_token(
    nc: NATSClient, evidence: EvidenceRecorder, bg_tasks: BgTasks
) -> None:
    """``aclose()`` on the prompt iterator runs the ``finally``: unregister().

    Plan §race-analysis #1 / #4: the consumer cancels mid-stream;
    the routing dict slot must be freed, so a follow-up prompt on
    the same mux gets a fresh token and routes correctly.

    Async-for ``break`` alone defers cleanup to GC (see
    ``_mux.py``'s docstring nudge), so we exercise the deterministic
    path: :func:`contextlib.aclosing`.
    """

    async def emit_forever(msg: Msg) -> None:
        async def emit() -> None:
            i = 0
            while True:
                await nc.publish(msg.reply, _response_chunk_bytes(f"x-{i}"))
                i += 1
                await asyncio.sleep(0.05)

        bg_tasks(asyncio.create_task(emit()))

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=emit_forever)
    try:
        agents = Agents(nc=nc)
        info = _make_agent_info(PROMPT_SUBJECT)
        agent = Agent(nc, info, close_event=agents.close_event)

        seen_first: list[str] = []
        # `agent.prompt()` is an async generator (has aclose), but the
        # advertised return type is the more general AsyncIterator.
        # cast() satisfies aclosing's type bound without a runtime change.
        stream_gen = cast(AsyncGenerator[object, None], agent.prompt("first"))
        async with aclosing(stream_gen) as stream:
            async for chunk in stream:
                if isinstance(chunk, ResponseChunk):
                    seen_first.append(chunk.text)
                    if len(seen_first) >= 2:
                        break

        # After aclose() the routing dict should be empty.
        mux = mux_for(nc)
        assert mux._routes == {}, f"orphan tokens after aclose: {list(mux._routes.keys())}"

        await agents.close()
    finally:
        await sub.unsubscribe()

    evidence.write_json("seen_first.json", seen_first)


async def test_close_before_prompt_raises_agents_closed_error(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """Plan §race-analysis #7 — half A: ``close()`` *before* ``prompt()``.

    Schedules close() to run before the prompt's first event-loop tick
    so the synchronous pre-flight check at the top of
    :meth:`Agent._stream_prompt` sees ``close_event.is_set()`` and
    raises :class:`AgentsClosedError`. This is the
    "obviously-closed" branch.
    """

    async def silent_agent(msg: Msg) -> None:
        del msg

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=silent_agent)
    try:
        agents = Agents(nc=nc)
        info = _make_agent_info(PROMPT_SUBJECT)
        agent = Agent(nc, info, close_event=agents.close_event)

        await agents.close()  # set close_event before any prompt runs

        with pytest.raises(AgentsClosedError):
            async for _ in agent.prompt("after-close"):
                pass

        assert mux_for(nc)._routes == {}
    finally:
        await sub.unsubscribe()

    evidence.write_json("status.json", {"raised": "AgentsClosedError"})


async def test_close_during_prompt_yields_protocol_error(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """Plan §race-analysis #7 — half B: ``close()`` fires *during* the loop.

    Once the prompt has gotten past its synchronous pre-flight check
    AND past the publish (so the post-publish close-watcher is armed),
    ``Agents.close()`` propagates via the per-stream watcher pushing
    :data:`_CLOSE_SENTINEL`; the iterator raises :class:`ProtocolError`
    (not :class:`AgentsClosedError`) so callers can branch on "torn
    down mid-flight" vs "called against a closed Agents."

    Synchronisation is event-driven, not ``asyncio.sleep(0)``-based:
    the fake agent yields one chunk, and the consumer signals an event
    on receipt. Once that fires, the consumer is provably *past* both
    pre-publish close checks and into the iteration body — so close
    can only land in the mid-stream path. Without this, an interim
    pre-publish race-window check could trip first and raise
    :class:`AgentsClosedError`, masquerading as the mid-stream path.
    """
    consumer_in_iteration = asyncio.Event()

    async def one_chunk_agent(msg: Msg) -> None:
        # Single chunk, no terminator — keeps the consumer iterating
        # forever after delivery so close can fire mid-loop.
        await nc.publish(msg.reply, _response_chunk_bytes("alive"))

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=one_chunk_agent)
    try:
        agents = Agents(nc=nc)
        info = _make_agent_info(PROMPT_SUBJECT)
        agent = Agent(nc, info, close_event=agents.close_event)

        outcome: dict[str, str] = {}

        async def consume() -> None:
            try:
                async for chunk in agent.prompt("hold open", timeout=60.0):
                    if isinstance(chunk, ResponseChunk):
                        # First chunk delivered → consumer is provably past
                        # publish + close-watcher arming; safe to fire close.
                        consumer_in_iteration.set()
            except AgentsClosedError as exc:
                outcome["raised"] = f"AgentsClosedError: {exc}"
            except ProtocolError as exc:
                outcome["raised"] = "ProtocolError"
                outcome["msg"] = str(exc)

        consumer = asyncio.create_task(consume())
        await asyncio.wait_for(consumer_in_iteration.wait(), timeout=2.0)
        await agents.close()
        await asyncio.wait_for(consumer, timeout=2.0)

        assert outcome.get("raised") == "ProtocolError", (
            f"expected mid-flight ProtocolError, got {outcome!r}"
        )
        assert "Agents is closed" in outcome.get("msg", "")
        assert mux_for(nc)._routes == {}
    finally:
        await sub.unsubscribe()

    evidence.write_json("outcome.json", outcome)

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

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.harness.evidence import EvidenceRecorder


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
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """A live consumer raises within ~50 ms of :meth:`Agents.close`, not on timeout."""

    async def trickle_agent(msg: Msg) -> None:
        async def emit() -> None:
            i = 0
            while True:
                await nc.publish(msg.reply, _response_chunk_bytes(f"trickle-{i}"))
                i += 1
                await asyncio.sleep(0.05)

        msg._emit_task = asyncio.create_task(emit())  # type: ignore[attr-defined]

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=trickle_agent)
    try:
        # Build an Agents that owns the mux, plus an Agent attached to it.
        agents = Agents(nc=nc)
        info = _make_agent_info(PROMPT_SUBJECT)
        agent = Agent(nc, info, mux=agents.mux, close_event=agents.close_event)

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


async def test_register_after_close_raises(nc: NATSClient, evidence: EvidenceRecorder) -> None:
    """Calling :meth:`Agent.prompt` after :meth:`Agents.close` raises cleanly."""
    agents = Agents(nc=nc)
    info = _make_agent_info(PROMPT_SUBJECT)
    agent = Agent(nc, info, mux=agents.mux, close_event=agents.close_event)

    await agents.close()

    with pytest.raises(AgentsClosedError):
        async for _ in agent.prompt("anyone home?"):
            pass

    evidence.write_json("status.json", {"raised": "AgentsClosedError"})


async def test_concurrent_prompts_isolated(nc: NATSClient, evidence: EvidenceRecorder) -> None:
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

        msg._emit_task = asyncio.create_task(emit())  # type: ignore[attr-defined]

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=echo_agent)
    try:
        agents = Agents(nc=nc)
        info = _make_agent_info(PROMPT_SUBJECT)
        agent = Agent(nc, info, mux=agents.mux, close_event=agents.close_event)

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
    nc: NATSClient, evidence: EvidenceRecorder
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

        msg._emit_task = asyncio.create_task(emit())  # type: ignore[attr-defined]

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=emit_forever)
    try:
        agents = Agents(nc=nc)
        info = _make_agent_info(PROMPT_SUBJECT)
        agent = Agent(nc, info, mux=agents.mux, close_event=agents.close_event)

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
        assert agents.mux._routes == {}, (
            f"orphan tokens after aclose: {list(agents.mux._routes.keys())}"
        )

        await agents.close()
    finally:
        await sub.unsubscribe()

    evidence.write_json("seen_first.json", seen_first)


async def test_concurrent_close_and_register_is_safe(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """Plan §race-analysis #7: ``close()`` racing with ``register()`` is safe.

    Either ``register()`` runs first and gets a sentinel via close()'s
    sweep, or it runs second and raises :class:`AgentsClosedError`.
    Both outcomes are acceptable; the bad outcome (orphan token, no
    error) MUST NOT happen.
    """

    async def silent_agent(msg: Msg) -> None:
        del msg

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=silent_agent)
    try:
        agents = Agents(nc=nc)
        info = _make_agent_info(PROMPT_SUBJECT)
        agent = Agent(nc, info, mux=agents.mux, close_event=agents.close_event)

        # Pre-warm the mux so close() has a real subscription to tear down.
        await agents.mux.start()

        outcomes: list[str] = []

        async def attempt_prompt() -> None:
            try:
                async for _ in agent.prompt("racy"):
                    pass
            except AgentsClosedError:
                outcomes.append("AgentsClosedError")
            except ProtocolError as exc:
                if "closed" in str(exc).lower():
                    outcomes.append("ProtocolError-closed")
                else:
                    outcomes.append(f"ProtocolError-other: {exc}")
            except Exception as exc:
                outcomes.append(f"unexpected: {type(exc).__name__}")

        # Fire prompt + close concurrently.
        await asyncio.gather(attempt_prompt(), agents.close())

        # Whatever order the race resolved in, we must have observed
        # one of the two clean-exit outcomes. The bad outcome (silent
        # hang or orphan token) would manifest as a hung gather above.
        assert outcomes and outcomes[0] in (
            "AgentsClosedError",
            "ProtocolError-closed",
        ), f"unexpected outcomes: {outcomes!r}"
        # And after close, no orphan tokens linger.
        assert agents.mux._routes == {}
    finally:
        await sub.unsubscribe()

    evidence.write_json("race_outcomes.json", outcomes)

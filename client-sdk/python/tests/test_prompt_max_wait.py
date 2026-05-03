"""End-to-end tests for the absolute ``max_wait_s`` ceiling on prompt streams.

These tests exercise the new
:class:`synadia_ai.agents.StreamMaxWaitExceededError` ceiling that the
Python SDK gained as the API-level analogue of the TypeScript SDK's
``PromptOptions.maxWaitMs`` (PR #66 — `requestMany` + sentinel). The
ceiling is distinct from the §6.6 per-chunk inactivity timeout: the
inactivity timer resets on every received chunk, so a stream that emits
a steady trickle could never time out under inactivity alone.

Each test uses a tiny in-process "agent" — a NATS subscription that
publishes wire-shape-correct chunks into ``msg.reply`` on demand — so
the suite covers the whole client path (mux subscribe + publish +
queue.get + decode + terminator) without depending on the agent-sdk
distribution.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import time
from pathlib import Path
from types import MappingProxyType
from typing import TYPE_CHECKING

import nats
import pytest

from synadia_ai.agents import (
    DEFAULT_PROMPT_MAX_WAIT_S,
    Agent,
    AgentInfo,
    EndpointInfo,
    ResponseChunk,
    StreamMaxWaitExceededError,
    StreamStalledError,
)
from tests.harness.evidence import EvidenceRecorder
from tests.harness.nats_server import start_server

if TYPE_CHECKING:
    from collections.abc import Callable

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    BgTasks = Callable[[asyncio.Task[object]], None]


PROMPT_SUBJECT = "agents.prompt.test-agent.pytest.maxwait"
_EVIDENCE_ROOT = Path(__file__).parent / "_evidence"


def _make_agent_info(prompt_subject: str) -> AgentInfo:
    """Build an :class:`AgentInfo` pointing at a test-controlled subject.

    Bypasses ``$SRV.INFO`` discovery — the test owns both ends of the
    wire, so we build the record directly.
    """
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
        session_name="maxwait",
        protocol_version="0.3",
        description="",
        version="0.0.0",
        metadata=MappingProxyType({"agent": "test-agent", "owner": "pytest"}),
        endpoints=(prompt_endpoint,),
        prompt_endpoint=prompt_endpoint,
    )


def _response_chunk_bytes(text: str) -> bytes:
    """Wire bytes for a §6.3 response chunk (bare-string shorthand)."""
    return json.dumps({"type": "response", "data": text}).encode("utf-8")


def test_max_wait_default_is_600s_and_constant_exported() -> None:
    """The default ceiling matches TS PR #66's ``DEFAULT_PROMPT_MAX_WAIT_MS = 600_000``.

    Asserts both the constant value and that the :meth:`Agent.__init__`
    kwarg actually defaults to it (so a careless rename of either side
    surfaces here, not at runtime).
    """
    assert DEFAULT_PROMPT_MAX_WAIT_S == 600.0
    sig = inspect.signature(Agent.__init__)
    assert sig.parameters["prompt_max_wait_s"].default is DEFAULT_PROMPT_MAX_WAIT_S


async def test_max_wait_exceeded_raises(
    nc: NATSClient, evidence: EvidenceRecorder, bg_tasks: BgTasks
) -> None:
    """An agent that never terminates triggers ``StreamMaxWaitExceededError``.

    Evidence: ``chunks.jsonl`` records every chunk delivered before
    the ceiling fired, so a human can verify the stream really was
    progressing (so this isn't an inactivity-timeout false positive).
    """
    chunks_observed: list[dict[str, object]] = []
    chunk_interval_s = 0.05

    async def fake_agent(msg: Msg) -> None:
        # Emit a chunk every 50 ms forever — never terminate. Runs in a
        # background task so the publish callback returns promptly.
        async def emit_loop() -> None:
            i = 0
            while True:
                await nc.publish(msg.reply, _response_chunk_bytes(f"tick-{i}"))
                i += 1
                await asyncio.sleep(chunk_interval_s)

        bg_tasks(asyncio.create_task(emit_loop()))

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=fake_agent)
    try:
        agent = Agent(nc, _make_agent_info(PROMPT_SUBJECT))
        start = time.monotonic()
        with pytest.raises(StreamMaxWaitExceededError) as excinfo:
            async for chunk in agent.prompt("trigger-forever", max_wait_s=0.5):
                if isinstance(chunk, ResponseChunk):
                    chunks_observed.append(
                        {"text": chunk.text, "elapsed_s": time.monotonic() - start}
                    )
        elapsed = time.monotonic() - start
    finally:
        await sub.unsubscribe()

    # Ceiling fired close to 0.5s, not the inactivity default (60s).
    assert 0.4 < elapsed < 1.5, f"max_wait fired at {elapsed:.3f}s — outside expected band"
    assert excinfo.value.max_wait_s == 0.5
    # At least two chunks proves the stream was *progressing* — i.e. the
    # ceiling fired, not the inactivity-gap path. We deliberately do NOT
    # assert a tighter count: the cadence target is 10 chunks (50 ms over
    # 500 ms) but bunched scheduling under CI load can drop the observed
    # count well below that without the underlying behaviour changing.
    # Two is the floor that distinguishes "made progress" from "silent
    # stall."
    assert len(chunks_observed) >= 2, (
        f"expected ≥2 chunks (proves progression, not stall); saw {len(chunks_observed)}"
    )
    evidence.write_jsonl("chunks.jsonl", chunks_observed)  # type: ignore[arg-type]


async def test_max_wait_with_terminator_in_time(
    nc: NATSClient, evidence: EvidenceRecorder, bg_tasks: BgTasks
) -> None:
    """A stream that terminates well inside the ceiling completes cleanly."""
    received_texts: list[str] = []

    async def fake_agent(msg: Msg) -> None:
        async def emit() -> None:
            for i in range(3):
                await nc.publish(msg.reply, _response_chunk_bytes(f"chunk-{i}"))
            # §6.5: zero-byte terminator, no headers.
            await nc.publish(msg.reply, b"")

        bg_tasks(asyncio.create_task(emit()))

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=fake_agent)
    try:
        agent = Agent(nc, _make_agent_info(PROMPT_SUBJECT))
        async for chunk in agent.prompt("terminate-please", max_wait_s=10.0):
            if isinstance(chunk, ResponseChunk):
                received_texts.append(chunk.text)
    finally:
        await sub.unsubscribe()

    assert received_texts == ["chunk-0", "chunk-1", "chunk-2"]
    evidence.write_json("received.json", received_texts)


async def test_max_wait_distinct_from_inactivity_timeout(
    nc: NATSClient, evidence: EvidenceRecorder, bg_tasks: BgTasks
) -> None:
    """Steady chunks (well under inactivity timeout) still trip the ceiling.

    Proves the ceiling is independent of the per-chunk timer: chunks
    arrive every 50 ms (well inside any reasonable inactivity timeout),
    yet the stream still fails with ``StreamMaxWaitExceededError`` —
    NOT ``StreamStalledError`` — once 0.3 s has elapsed.

    Three assertions pin the dual-timer claim, not just the error class:

    - ``elapsed`` close to ``max_wait_s=0.3``, not the 60 s inactivity
      timeout. If ``max_wait_s`` were mis-wired to feed the inactivity
      path, the test would either fail with ``StreamStalledError`` or
      hang for 60 s — not raise the right class at the right time.
    - Chunks observed must show the inactivity timer is being reset by
      incoming traffic. Two or more chunks across the 0.3 s window with
      a 50 ms cadence is conservative evidence of "stream progressing."
    - The error class. (Already implied by ``pytest.raises``, but
      together with the elapsed band it rules out an accidental
      stall-path raise.)
    """
    chunks_observed: list[dict[str, object]] = []

    async def fake_agent(msg: Msg) -> None:
        async def emit() -> None:
            i = 0
            while True:
                await nc.publish(msg.reply, _response_chunk_bytes(f"steady-{i}"))
                i += 1
                await asyncio.sleep(0.05)

        bg_tasks(asyncio.create_task(emit()))

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=fake_agent)
    try:
        agent = Agent(nc, _make_agent_info(PROMPT_SUBJECT))
        start = time.monotonic()
        # Inactivity timeout very high (60s) so it cannot trip first.
        with pytest.raises(StreamMaxWaitExceededError) as excinfo:
            async for chunk in agent.prompt("steady", timeout=60.0, max_wait_s=0.3):
                if isinstance(chunk, ResponseChunk):
                    chunks_observed.append(
                        {"text": chunk.text, "elapsed_s": time.monotonic() - start}
                    )
        elapsed = time.monotonic() - start
    finally:
        await sub.unsubscribe()

    assert excinfo.value.max_wait_s == 0.3
    # Tight band: ceiling must fire close to 0.3 s, definitely not the
    # 60 s inactivity timeout. Lower bound = ceiling minus jitter; upper
    # bound = generous slack for CI noise but well below inactivity.
    assert 0.25 < elapsed < 1.0, (
        f"max_wait fired at {elapsed:.3f}s — outside dual-timer-distinct band"
    )
    # At least two chunks proves the inactivity timer was being reset by
    # incoming traffic. If max_wait were mis-wired to the inactivity
    # path, a stream emitting every 50 ms would have its stall timer
    # reset on each chunk and never raise.
    assert len(chunks_observed) >= 2, (
        f"expected ≥2 chunks proving inactivity timer was being reset; saw {len(chunks_observed)}"
    )
    evidence.write_jsonl("chunks.jsonl", chunks_observed)  # type: ignore[arg-type]
    evidence.write_json(
        "timing.json",
        {"elapsed_s": round(elapsed, 3), "max_wait_s": 0.3, "chunks": len(chunks_observed)},
    )


async def test_inactivity_raises_stream_stalled_error(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """A silent agent triggers :class:`StreamStalledError`, not the ceiling."""

    async def silent_agent(msg: Msg) -> None:
        # Publish nothing. The reply subject just stays empty.
        del msg

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=silent_agent)
    try:
        agent = Agent(nc, _make_agent_info(PROMPT_SUBJECT))
        with pytest.raises(StreamStalledError) as excinfo:
            # Inactivity 0.2s, ceiling 5s → inactivity wins.
            async for _ in agent.prompt("silent", timeout=0.2, max_wait_s=5.0):
                pass
    finally:
        await sub.unsubscribe()

    assert excinfo.value.timeout_s == 0.2
    evidence.write_json("error.json", {"timeout_s": excinfo.value.timeout_s})


async def test_max_wait_fires_after_connection_severed(
    request: pytest.FixtureRequest,
    bg_tasks: BgTasks,
    tmp_path: Path,
) -> None:
    """Connection severed mid-stream → ceiling fires after ``max_wait_s``.

    Plan §race #8 safety net. A catastrophic broker death (or any
    network drop where chunks stop forever) leaves the per-chunk
    inactivity timer as the only fallback. With ``max_wait_s`` set
    tight and ``timeout`` (inactivity) set high, the ceiling rescues
    the stream after the absolute deadline regardless of whether the
    transport ever told us it died.

    Uses a dedicated ``nats-server`` (NOT the session-scoped fixture)
    so killing the broker mid-test does not poison every other test.
    Caller connects with ``allow_reconnect=False`` so the dead server
    stays dead — no background reconnect loop muddying the timing.
    """
    evidence = EvidenceRecorder.for_test(_EVIDENCE_ROOT, request.node.nodeid)
    server = start_server(tmp_path / "nats-logs")
    try:
        client = await nats.connect(server.url, allow_reconnect=False)
        try:
            chunks_observed: list[dict[str, object]] = []

            async def fake_agent(msg: Msg) -> None:
                async def emit_loop() -> None:
                    i = 0
                    while True:
                        try:
                            await client.publish(msg.reply, _response_chunk_bytes(f"tick-{i}"))
                        except Exception:
                            # Broker is gone; bail quietly. The bg_tasks
                            # fixture will cancel us at teardown anyway,
                            # but exiting cleanly avoids spurious tracebacks.
                            return
                        i += 1
                        await asyncio.sleep(0.05)

                bg_tasks(asyncio.create_task(emit_loop()))

            sub = await client.subscribe(PROMPT_SUBJECT, cb=fake_agent)
            # Two chunks is the floor that proves the consumer was
            # iterating before we killed the broker (i.e. this is the
            # connection-severed path, not "broker died before publish
            # ever landed"). Bigger numbers just narrow the timing
            # window for the kill — at 50 ms cadence and a 1.0 s
            # ceiling, ``kill_at=2`` lands ~100 ms in with ~900 ms of
            # ceiling remaining, robust against CI scheduler bunching.
            kill_at_chunks = 2
            kill_ts: float | None = None
            try:
                agent = Agent(client, _make_agent_info(PROMPT_SUBJECT))
                start = time.monotonic()
                with pytest.raises(StreamMaxWaitExceededError) as excinfo:
                    async for chunk in agent.prompt("sever-me", timeout=60.0, max_wait_s=1.0):
                        if isinstance(chunk, ResponseChunk):
                            chunks_observed.append(
                                {
                                    "text": chunk.text,
                                    "elapsed_s": time.monotonic() - start,
                                }
                            )
                            if len(chunks_observed) == kill_at_chunks:
                                # Kill the broker. From here on no chunks will
                                # ever arrive — only the ceiling can save us.
                                kill_ts = time.monotonic() - start
                                server.stop()
                elapsed = time.monotonic() - start
            finally:
                with contextlib.suppress(Exception):
                    await sub.unsubscribe()
        finally:
            with contextlib.suppress(Exception):
                await client.close()
    finally:
        server.stop()

    assert excinfo.value.max_wait_s == 1.0
    assert kill_ts is not None
    # Ceiling must fire close to 1.0 s after start, regardless of when the
    # broker died. Kernel TCP teardown + asyncio scheduling can each add
    # tens of ms, and CI machines are noisy — generous slack.
    assert 0.9 < elapsed < 2.5, f"max_wait fired at {elapsed:.3f}s — outside expected band"
    assert len(chunks_observed) >= kill_at_chunks
    evidence.write_jsonl("chunks.jsonl", chunks_observed)  # type: ignore[arg-type]
    evidence.write_json(
        "timing.json",
        {
            "kill_at_s": round(kill_ts, 3),
            "max_wait_raised_at_s": round(elapsed, 3),
            "max_wait_s": 1.0,
            "inactivity_timeout_s": 60.0,
        },
    )

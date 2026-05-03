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
import inspect
import json
import time
from types import MappingProxyType
from typing import TYPE_CHECKING

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

if TYPE_CHECKING:
    from collections.abc import Callable

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.harness.evidence import EvidenceRecorder

    BgTasks = Callable[[asyncio.Task[object]], None]


PROMPT_SUBJECT = "agents.prompt.test-agent.pytest.maxwait"


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
    # We saw at least a handful of chunks — proves the stream was
    # progressing (so this is the ceiling firing, not the inactivity-gap path).
    assert len(chunks_observed) >= 4, (
        f"expected ≥4 chunks at 50 ms cadence within 500 ms; saw {len(chunks_observed)}"
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
    """

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
        # Inactivity timeout very high (60s) so it cannot trip first.
        with pytest.raises(StreamMaxWaitExceededError):
            async for _ in agent.prompt("steady", timeout=60.0, max_wait_s=0.3):
                pass
    finally:
        await sub.unsubscribe()
    evidence.write_json("note.json", {"verified": "ceiling, not stall"})


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

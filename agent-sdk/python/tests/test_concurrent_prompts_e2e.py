"""``AgentService(max_concurrent_prompts=...)`` on the wire.

At the default one instance serves one prompt at a time: the prompt
endpoint awaits each request in turn, and the next one waits in the
subscription. Above 1 each request runs in a task of its own, up to the
limit, and the next waits in the subscription once every slot is busy.
These tests pin the default — the option not passed at all, and passed as
1 — next to the concurrent mode: overlap, the limit, error completion,
``stop()`` with prompts in flight, the context each prompt runs in, the
prompt endpoint's ``$SRV.STATS``, and the loop between two agents that
motivated the option.

A status request is the barrier that proves the host has read a prompt: a
caller's messages reach a subscriber connection in the order they were
published, so once the host answers a status request sent after a prompt,
that prompt is in the host's hands — served, or waiting.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from collections.abc import AsyncIterator, Awaitable, Callable
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

import nats
import pytest
import pytest_asyncio
from synadia_ai.agents import Agent, Agents, Envelope, ProtocolError, ResponseChunk

import synadia_ai.agent_service.service as service_module
from synadia_ai.agent_service import (
    AgentService,
    CallNext,
    PromptStream,
    RequestInterceptorContext,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg
    from nats.aio.subscription import Subscription

    from tests.harness.evidence import EvidenceRecorder
    from tests.harness.nats_server import RunningServer

Frame = tuple[str, ...]
Handler = Callable[[Envelope, PromptStream], Awaitable[None]]

SERVICE_LOGGER = "synadia_ai.agent_service.service"
WAIT_S = 5.0

# The option not passed, and passed as its default: both must be today's service.
DEFAULT: dict[str, Any] = {}
DEFAULT_EXPLICIT: dict[str, Any] = {"max_concurrent_prompts": 1}
TWO_SLOTS: dict[str, Any] = {"max_concurrent_prompts": 2}


async def _start(
    nc: NATSClient, name: str, handler: Handler, options: dict[str, Any], **extra: Any
) -> AgentService:
    svc = AgentService(
        nc=nc,
        agent="concurrency",
        owner="o",
        session_name=name,
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        **options,
        **extra,
    )
    svc.on_prompt(handler)
    await svc.start()
    return svc


def _frame(msg: Msg) -> Frame:
    headers = msg.headers or {}
    code = headers.get("Nats-Service-Error-Code")
    if code is not None:
        return ("error", code, headers.get("Nats-Service-Error", ""))
    if msg.data == b"":
        return ("terminator",)
    chunk = json.loads(msg.data)
    return ("ack",) if chunk["type"] == "status" else ("response", str(chunk["data"]))


async def _read(sub: Subscription, idle_s: float) -> list[Frame]:
    """Every frame on ``sub`` up to the terminator; ``("silent",)`` after ``idle_s`` without one."""
    frames: list[Frame] = []
    try:
        while True:
            try:
                msg = await sub.next_msg(timeout=idle_s)
            except TimeoutError:
                frames.append(("silent",))
                return frames
            frames.append(_frame(msg))
            if msg.data == b"" and not msg.headers:
                return frames
    finally:
        await sub.unsubscribe()


async def _send(
    nc: NATSClient, svc: AgentService, text: str, *, idle_s: float = WAIT_S
) -> asyncio.Task[list[Frame]]:
    """Publish one prompt now; the task collects the frames it draws."""
    inbox = nc.new_inbox()
    sub = await nc.subscribe(inbox)
    await nc.publish(svc.subject.prompt, text.encode(), reply=inbox)
    return asyncio.create_task(_read(sub, idle_s))


async def _host_has_read(nc: NATSClient, svc: AgentService) -> None:
    """Return once the host has read every prompt published before this call."""
    await nc.request(svc.subject.status, b"", timeout=WAIT_S)


def _served(text: str) -> list[Frame]:
    return [("ack",), ("response", f"done {text}"), ("terminator",)]


class _Probe:
    """A handler that records its prompts and holds each until the test releases it."""

    def __init__(self) -> None:
        self.events: list[str] = []
        self.started: defaultdict[str, asyncio.Event] = defaultdict(asyncio.Event)
        self.release: defaultdict[str, asyncio.Event] = defaultdict(asyncio.Event)

    async def handler(self, envelope: Envelope, stream: PromptStream) -> None:
        text = envelope.prompt
        self.events.append(f"start {text}")
        self.started[text].set()
        try:
            await self.release[text].wait()
        except asyncio.CancelledError:
            self.events.append(f"cancelled {text}")
            raise
        await stream.send(f"done {text}")
        self.events.append(f"end {text}")

    async def wait_started(self, text: str) -> None:
        await asyncio.wait_for(self.started[text].wait(), timeout=WAIT_S)


async def _prompt_endpoint_stats(nc: NATSClient, svc: AgentService) -> dict[str, Any]:
    """The prompt endpoint's entry in this instance's ``$SRV.STATS`` reply."""
    reply = await nc.request(f"$SRV.STATS.agents.{svc.instance_id}", b"", timeout=WAIT_S)
    endpoints = json.loads(reply.data)["endpoints"]
    stats: dict[str, Any] = next(e for e in endpoints if e["name"] == "prompt")
    return stats


# --- the option -------------------------------------------------------------


@pytest.mark.parametrize("value", [0, -1, 1.5, True])
async def test_max_concurrent_prompts_must_be_an_int_of_at_least_one(
    nc: NATSClient, value: int
) -> None:
    with pytest.raises(ValueError, match="max_concurrent_prompts must be an int >= 1"):
        AgentService(
            nc=nc,
            agent="concurrency",
            owner="o",
            session_name="invalid",
            max_concurrent_prompts=value,
        )


@pytest.mark.parametrize(
    ("options", "endpoint_handler"),
    [
        (DEFAULT, "_on_prompt_request"),
        (DEFAULT_EXPLICIT, "_on_prompt_request"),
        (TWO_SLOTS, "_dispatch_prompt_request"),
    ],
    ids=["default", "explicit-1", "two-slots"],
)
async def test_at_the_default_the_endpoint_awaits_the_request_handler_itself(
    nc: NATSClient, options: dict[str, Any], endpoint_handler: str
) -> None:
    """The default registers today's handler with nats-py: the same code path, inline."""
    probe = _Probe()
    svc = await _start(nc, "registration", probe.handler, options)
    try:
        assert svc._service is not None
        prompt = next(e for e in svc._service._endpoints if e._name == "prompt")
        assert prompt._handler == getattr(svc, endpoint_handler)
    finally:
        await svc.stop()


# --- overlap and the limit --------------------------------------------------


@pytest.mark.parametrize("options", [DEFAULT, DEFAULT_EXPLICIT], ids=["default", "explicit-1"])
async def test_at_the_default_overlapping_prompts_are_served_one_after_the_other(
    nc: NATSClient, evidence: EvidenceRecorder, options: dict[str, Any]
) -> None:
    probe = _Probe()
    svc = await _start(nc, "serial", probe.handler, options)
    try:
        one = await _send(nc, svc, "one")
        await probe.wait_started("one")
        two = await _send(nc, svc, "two")
        await _host_has_read(nc, svc)
        assert not probe.started["two"].is_set(), "a second prompt started while one ran"
        probe.release["one"].set()
        probe.release["two"].set()
        frames = {"one": await one, "two": await two}
    finally:
        await svc.stop()
    evidence.write_jsonl("frames.jsonl", [{k: list(map(list, v))} for k, v in frames.items()])
    assert frames == {"one": _served("one"), "two": _served("two")}
    assert probe.events == ["start one", "end one", "start two", "end two"]


async def test_with_two_slots_overlapping_prompts_are_served_at_once(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    probe = _Probe()
    svc = await _start(nc, "overlap", probe.handler, TWO_SLOTS)
    try:
        one = await _send(nc, svc, "one")
        await probe.wait_started("one")
        two = await _send(nc, svc, "two")
        await probe.wait_started("two")
        assert not one.done(), "the first prompt ended before the second started"
        probe.release["two"].set()
        two_frames = await two
        probe.release["one"].set()
        one_frames = await one
    finally:
        await svc.stop()
    evidence.write_jsonl("frames.jsonl", [{"one": one_frames}, {"two": two_frames}])
    assert one_frames == _served("one")
    assert two_frames == _served("two")
    assert probe.events == ["start one", "start two", "end two", "end one"]


async def test_with_every_slot_busy_the_next_prompt_waits_then_is_served(
    nc: NATSClient,
) -> None:
    probe = _Probe()
    svc = await _start(nc, "limit", probe.handler, TWO_SLOTS)
    try:
        one = await _send(nc, svc, "one")
        two = await _send(nc, svc, "two")
        await probe.wait_started("one")
        await probe.wait_started("two")
        three = await _send(nc, svc, "three")
        await _host_has_read(nc, svc)
        assert not probe.started["three"].is_set(), "a third prompt started with two slots busy"
        probe.release["one"].set()
        await probe.wait_started("three")
        probe.release["two"].set()
        probe.release["three"].set()
        frames = [await one, await two, await three]
    finally:
        await svc.stop()
    assert frames == [_served("one"), _served("two"), _served("three")]
    assert probe.events.index("end one") < probe.events.index("start three")


# --- error completion -------------------------------------------------------


@pytest.mark.parametrize("options", [DEFAULT, TWO_SLOTS], ids=["default", "two-slots"])
async def test_a_handler_that_raises_ends_its_stream_with_the_error_frame_and_terminator(
    nc: NATSClient, caplog: pytest.LogCaptureFixture, options: dict[str, Any]
) -> None:
    secret = "secret-detail-of-the-handler"

    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        if envelope.prompt == "boom":
            raise RuntimeError(secret)
        await stream.send(f"done {envelope.prompt}")

    svc = await _start(nc, "raises", handler, options)
    try:
        with caplog.at_level(logging.ERROR, logger=SERVICE_LOGGER):
            boom = await _send(nc, svc, "boom")
            fine = await _send(nc, svc, "fine")
            frames = {"boom": await boom, "fine": await fine}
    finally:
        await svc.stop()
    assert frames == {
        "boom": [("ack",), ("error", "500", "handler error"), ("terminator",)],
        "fine": _served("fine"),
    }
    assert "prompt handler raised on" in caplog.text
    assert "prompt request failed" not in caplog.text
    assert secret not in caplog.text


# --- stop() -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("options", "in_flight", "waiting"),
    [(DEFAULT, ["one"], "two"), (TWO_SLOTS, ["one", "two"], "three")],
    ids=["default", "two-slots"],
)
async def test_stop_cancels_the_prompts_in_flight_and_drops_the_waiting_one(
    nc: NATSClient,
    evidence: EvidenceRecorder,
    options: dict[str, Any],
    in_flight: list[str],
    waiting: str,
) -> None:
    """Each prompt in flight: ``CancelledError`` in its handler, then the terminator.

    No error frame, and all of it before ``stop()`` returns. The prompt
    still waiting — in the subscription at the default, for a slot above
    it — gets no reply at all.
    """
    probe = _Probe()
    svc = await _start(nc, "stop", probe.handler, options)
    calls: dict[str, asyncio.Task[list[Frame]]] = {}
    for text in in_flight:
        calls[text] = await _send(nc, svc, text)
        await probe.wait_started(text)
    calls[waiting] = await _send(nc, svc, waiting, idle_s=1.0)
    await _host_has_read(nc, svc)
    probe.events.append("stop called")
    await svc.stop()
    probe.events.append("stop returned")

    frames = {text: await call for text, call in calls.items()}
    evidence.write_jsonl("frames.jsonl", [{k: list(map(list, v))} for k, v in frames.items()])
    for text in in_flight:
        assert frames[text] == [("ack",), ("terminator",)], text
        assert (
            probe.events.index("stop called")
            < probe.events.index(f"cancelled {text}")
            < probe.events.index("stop returned")
        )
    assert frames[waiting] == [("silent",)]
    assert f"start {waiting}" not in probe.events


# --- context ----------------------------------------------------------------


async def test_each_prompt_runs_in_its_own_context(nc: NATSClient) -> None:
    """Two overlapping prompts, each bound by a request interceptor, see their own value."""
    bound: ContextVar[str | None] = ContextVar("bound", default=None)
    both_started = asyncio.Event()
    started: list[str] = []

    class Bind:
        async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
            token = bound.set(f"bound:{ctx.envelope.prompt}")
            try:
                await call_next()
            finally:
                bound.reset(token)

    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        started.append(envelope.prompt)
        if len(started) == 2:
            both_started.set()
        # Both prompts are in flight, each bound by the interceptor, when either reads.
        await asyncio.wait_for(both_started.wait(), timeout=WAIT_S)
        await stream.send(bound.get() or "unbound")

    svc = await _start(nc, "context", handler, TWO_SLOTS, interceptors=[Bind()])
    try:
        one = await _send(nc, svc, "one")
        two = await _send(nc, svc, "two")
        frames = [await one, await two]
    finally:
        await svc.stop()
    assert frames == [
        [("ack",), ("response", "bound:one"), ("terminator",)],
        [("ack",), ("response", "bound:two"), ("terminator",)],
    ]
    assert bound.get() is None


# --- $SRV.STATS -------------------------------------------------------------

WORK_S = 0.3


@pytest.mark.parametrize("options", [DEFAULT, TWO_SLOTS], ids=["default", "two-slots"])
async def test_the_prompt_endpoint_stats_time_each_prompt_as_at_the_default(
    nc: NATSClient, options: dict[str, Any]
) -> None:
    """Three prompts of ``WORK_S`` each: ``3 * WORK_S`` of processing time in both modes.

    With two slots the third waits ``WORK_S`` for one: counted, it would
    show; left to nats-py alone, only the dispatch would be timed.
    """

    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        await asyncio.sleep(WORK_S)
        await stream.send(f"done {envelope.prompt}")

    svc = await _start(nc, "stats", handler, options)
    try:
        calls = [await _send(nc, svc, text) for text in ("one", "two", "three")]
        frames = [await call for call in calls]
        stats = await _prompt_endpoint_stats(nc, svc)
    finally:
        await svc.stop()
    assert frames == [_served("one"), _served("two"), _served("three")]
    assert stats["num_requests"] == 3
    assert stats["num_errors"] == 0
    assert stats["last_error"] == ""
    work_ns = int(WORK_S * 1e9)
    assert 3 * work_ns <= stats["processing_time"] < 3 * work_ns + work_ns // 2, stats
    assert stats["average_processing_time"] == int(stats["processing_time"] / 3)


@pytest.mark.parametrize("options", [DEFAULT, TWO_SLOTS], ids=["default", "two-slots"])
async def test_an_exception_that_escapes_a_request_is_counted_never_lost(
    nc: NATSClient,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
    options: dict[str, Any],
) -> None:
    """The SDK's own reply failing escapes the request: nats-py counts it at the default.

    Above 1 the request's task ends with it: counted the same way, and logged.
    """
    escaped = ConnectionError("reply failed")

    async def failing_respond_failure(_request: object, _exc: Exception) -> None:
        raise escaped

    monkeypatch.setattr(service_module, "_respond_failure", failing_respond_failure)

    async def handler(_envelope: Envelope, _stream: PromptStream) -> None:
        raise RuntimeError("handler failed")

    svc = await _start(nc, "escapes", handler, options)
    try:
        with caplog.at_level(logging.ERROR, logger=SERVICE_LOGGER):
            frames = await (await _send(nc, svc, "boom"))
            stats = await _prompt_endpoint_stats(nc, svc)
    finally:
        await svc.stop()
    assert frames == [("ack",), ("terminator",)]
    assert stats["num_requests"] == 1
    assert stats["num_errors"] == 1
    assert stats["last_error"] == repr(escaped)
    if options == TWO_SLOTS:
        assert "prompt request failed on agents.prompt.concurrency.o.escapes" in caplog.text
        assert "reply failed" not in caplog.text


# --- the loop between two agents --------------------------------------------

LOOP_TIMEOUT_S = 10.0
STALL_S = 1.0


@pytest_asyncio.fixture
async def nc_b(nats_server: RunningServer) -> AsyncIterator[NATSClient]:
    """A second connection, for the second agent of the loop."""
    client = await nats.connect(nats_server.url)
    try:
        yield client
    finally:
        await client.close()


async def _text(agent: Agent, prompt: str, *, timeout: float) -> str:
    parts: list[str] = []
    async for chunk in agent.prompt(prompt, timeout=timeout):
        if isinstance(chunk, ResponseChunk):
            parts.append(chunk.text)
    return "".join(parts)


async def _find(agents: Agents, svc: AgentService) -> Agent:
    found = await agents.discover(timeout=1.0)
    return next(agent for agent in found if agent.prompt_subject == svc.subject.prompt)


async def _loop(
    nc: NATSClient, nc_b: NATSClient, options: dict[str, Any], *, inner_timeout: float
) -> tuple[str | ProtocolError, float]:
    """A caller prompts A; A prompts B; B prompts A back; each answers in turn.

    Each agent prompts the other through a client on its own connection.
    Returns A's answer — or the error the caller's prompt raised — and the
    seconds that prompt took, discovery excluded.
    """
    agents_a, agents_b, caller = Agents(nc=nc), Agents(nc=nc_b), Agents(nc=nc)
    peers: dict[str, Agent] = {}

    async def a(envelope: Envelope, stream: PromptStream) -> None:
        if envelope.prompt == "from-b":
            await stream.send("a answers b")
            return
        await stream.send(f"a got: {await _text(peers['b'], 'from-a', timeout=inner_timeout)}")

    async def b(envelope: Envelope, stream: PromptStream) -> None:
        await stream.send(f"b got: {await _text(peers['a'], 'from-b', timeout=inner_timeout)}")

    svc_a = await _start(nc, "loop-a", a, options)
    svc_b = await _start(nc_b, "loop-b", b, options)
    try:
        peers["b"] = await _find(agents_a, svc_b)
        peers["a"] = await _find(agents_b, svc_a)
        entry = await _find(caller, svc_a)
        started = time.monotonic()
        outcome: str | ProtocolError
        try:
            outcome = await _text(entry, "start", timeout=LOOP_TIMEOUT_S)
        except ProtocolError as exc:
            outcome = exc
        return outcome, time.monotonic() - started
    finally:
        await svc_a.stop()
        await svc_b.stop()
        for agents in (agents_a, agents_b, caller):
            await agents.close()


async def test_a_loop_between_two_agents_with_two_slots_each_completes(
    nc: NATSClient, nc_b: NATSClient
) -> None:
    outcome, elapsed = await _loop(nc, nc_b, TWO_SLOTS, inner_timeout=LOOP_TIMEOUT_S)
    assert outcome == "a got: b got: a answers b"
    assert elapsed < LOOP_TIMEOUT_S / 5, f"the loop took {elapsed:.2f}s — it waited for a timeout"


async def test_at_the_default_a_loop_between_two_agents_waits_for_the_timeout(
    nc: NATSClient, nc_b: NATSClient
) -> None:
    """A serves one prompt at a time, so B's prompt back to A stalls until B gives up.

    B's stall fails B's handler, which fails A's: the caller gets an error.
    """
    outcome, elapsed = await _loop(nc, nc_b, DEFAULT, inner_timeout=STALL_S)
    assert isinstance(outcome, ProtocolError), outcome
    assert STALL_S <= elapsed < LOOP_TIMEOUT_S

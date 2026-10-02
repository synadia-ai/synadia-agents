"""``AgentService``'s extension hooks on the wire.

Request interceptors around the handler — order, refusal, context, the
contract on ``call_next()`` — and the ``heartbeat_extras`` provider on the
heartbeat and the status reply. The TypeScript host's
``request-interceptors.test.ts`` covers the same rows.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

import pytest
from synadia_ai.agents import Envelope, HeartbeatPayload, ProtocolError

from synadia_ai.agent_service import (
    AgentService,
    CallNext,
    PromptStream,
    RequestInterceptor,
    RequestInterceptorContext,
    RequestRejectedError,
)
from tests.harness.wait import wait_for

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.harness.evidence import EvidenceRecorder

Handler = Callable[[str], Awaitable[str]]


async def _echo(text: str) -> str:
    return f"echo:{text}"


async def _start(
    nc: NATSClient,
    name: str,
    *,
    interceptors: Sequence[RequestInterceptor] = (),
    heartbeat_extras: Callable[[], Mapping[str, object]] | None = None,
    handler: Handler = _echo,
) -> AgentService:
    svc = AgentService(
        nc=nc,
        agent="icpt",
        owner="o",
        session_name=name,
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        interceptors=interceptors,
        heartbeat_extras=heartbeat_extras,
    )

    async def on_prompt(envelope: Envelope, stream: PromptStream) -> None:
        await stream.send(await handler(envelope.prompt))

    svc.on_prompt(on_prompt)
    await svc.start()
    return svc


def _frame(msg: Msg) -> tuple[str, ...]:
    headers = msg.headers or {}
    code = headers.get("Nats-Service-Error-Code")
    if code is not None:
        return ("error", code, headers.get("Nats-Service-Error", ""))
    if msg.data == b"":
        return ("terminator",)
    chunk = json.loads(msg.data)
    return ("ack",) if chunk["type"] == "status" else ("response", str(chunk["data"]))


async def _frames(
    nc: NATSClient, svc: AgentService, text: str, evidence: EvidenceRecorder | None = None
) -> list[tuple[str, ...]]:
    """Every frame a request draws, up to and including the terminator."""
    inbox = nc.new_inbox()
    sub = await nc.subscribe(inbox)
    try:
        await nc.publish(svc.subject.prompt, text.encode(), reply=inbox)
        frames: list[tuple[str, ...]] = []
        while True:
            msg = await asyncio.wait_for(sub.next_msg(), timeout=5.0)
            frames.append(_frame(msg))
            if msg.data == b"" and not msg.headers:
                break
    finally:
        await sub.unsubscribe()
    if evidence is not None:
        evidence.write_jsonl("frames.jsonl", [list(f) for f in frames])
    return frames


async def test_the_chain_runs_first_listed_outermost_around_the_ack_and_the_handler(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    order: list[str] = []

    class Tag:
        def __init__(self, name: str) -> None:
            self._name = name

        async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
            order.append(f"{self._name}:before")
            await call_next()
            order.append(f"{self._name}:after")

    async def handler(text: str) -> str:
        order.append("handler")
        return text

    svc = await _start(nc, "order", interceptors=[Tag("outer"), Tag("inner")], handler=handler)
    try:
        frames = await _frames(nc, svc, "hi", evidence)
    finally:
        await svc.stop()
    assert frames == [("ack",), ("response", "hi"), ("terminator",)]
    assert order == ["outer:before", "inner:before", "handler", "inner:after", "outer:after"]


async def test_the_handler_sees_the_context_an_interceptor_runs_call_next_in(
    nc: NATSClient,
) -> None:
    bound: ContextVar[str | None] = ContextVar("bound", default=None)

    class Bind:
        async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
            token = bound.set(f"bound:{ctx.envelope.prompt}")
            try:
                await call_next()
            finally:
                bound.reset(token)

    async def handler(_text: str) -> str:
        await asyncio.sleep(0.005)
        return bound.get() or "unbound"

    svc = await _start(nc, "context", interceptors=[Bind()], handler=handler)
    try:
        frames = await _frames(nc, svc, "x")
    finally:
        await svc.stop()
    assert frames[1] == ("response", "bound:x")
    assert bound.get() is None


@pytest.mark.parametrize(
    ("raised", "expected"),
    [
        (RequestRejectedError(403, "go away"), ("error", "403", "go away")),
        (RequestRejectedError(429, "slow down\nplease"), ("error", "429", "slow down | please")),
        (ProtocolError("bad extras"), ("error", "400", "bad extras")),
        (RuntimeError("secret detail"), ("error", "500", "handler error")),
    ],
    ids=["403", "429-multiline", "protocol-error-400", "other-500"],
)
async def test_a_refusal_before_call_next_answers_its_code_and_no_ack(
    nc: NATSClient, raised: Exception, expected: tuple[str, ...]
) -> None:
    class Refuse:
        async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
            raise raised

    handled = False

    async def handler(text: str) -> str:
        nonlocal handled
        handled = True
        return text

    svc = await _start(nc, f"refuse-{expected[1]}", interceptors=[Refuse()], handler=handler)
    try:
        frames = await _frames(nc, svc, "x")
    finally:
        await svc.stop()
    assert frames == [expected, ("terminator",)]
    assert handled is False


@pytest.mark.parametrize(
    "raised",
    [RuntimeError("secret detail"), RequestRejectedError(403, "too late")],
    ids=["runtime-error", "request-rejected"],
)
async def test_a_failure_after_call_next_returned_keeps_the_reply_and_is_logged(
    nc: NATSClient,
    caplog: pytest.LogCaptureFixture,
    evidence: EvidenceRecorder,
    raised: Exception,
) -> None:
    class Late:
        async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
            await call_next()
            raise raised

    svc = await _start(nc, f"late-{type(raised).__name__.lower()}", interceptors=[Late()])
    try:
        with caplog.at_level(logging.ERROR, logger="synadia_ai.agent_service"):
            frames = await _frames(nc, svc, "x", evidence)
    finally:
        await svc.stop()
    assert frames == [("ack",), ("response", "echo:x"), ("terminator",)]
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert [r.getMessage() for r in errors] == [
        f"request interceptor failed on {svc.subject.prompt} after the handler completed; "
        "the reply is kept (exception)"
    ]
    # The fixed line only: the exception's text and traceback never reach the log.
    assert all(r.exc_info is None for r in caplog.records)
    assert not any(
        "secret detail" in r.getMessage() or "too late" in r.getMessage() for r in caplog.records
    )


async def test_a_handler_failure_passes_through_the_chain_which_may_replace_it(
    nc: NATSClient,
) -> None:
    seen: list[BaseException] = []

    class Watch:
        async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
            try:
                await call_next()
            except Exception as exc:
                seen.append(exc)
                raise RequestRejectedError(503, "handler unavailable") from exc

    async def boom(_text: str) -> str:
        raise RuntimeError("boom")

    svc = await _start(nc, "replace", interceptors=[Watch()], handler=boom)
    try:
        frames = await _frames(nc, svc, "x")
    finally:
        await svc.stop()
    assert frames == [("ack",), ("error", "503", "handler unavailable"), ("terminator",)]
    assert len(seen) == 1


async def test_an_interceptor_that_neither_refuses_nor_calls_next_is_a_500(
    nc: NATSClient,
) -> None:
    class Swallow:
        async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
            return None

    svc = await _start(nc, "swallow", interceptors=[Swallow()])
    try:
        frames = await _frames(nc, svc, "x")
    finally:
        await svc.stop()
    assert frames == [("error", "500", "handler error"), ("terminator",)]


async def test_a_second_call_of_call_next_is_refused(nc: NATSClient) -> None:
    second: list[BaseException] = []

    class Twice:
        async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
            await call_next()
            try:
                await call_next()
            except RuntimeError as exc:
                second.append(exc)

    calls = 0

    async def handler(text: str) -> str:
        nonlocal calls
        calls += 1
        return text

    svc = await _start(nc, "twice", interceptors=[Twice()], handler=handler)
    try:
        frames = await _frames(nc, svc, "x")
    finally:
        await svc.stop()
    assert [f[0] for f in frames] == ["ack", "response", "terminator"]
    assert calls == 1
    assert len(second) == 1


@pytest.mark.parametrize("code", [200, 399, 600, True, 400.0])
def test_a_request_rejected_error_code_must_be_400_to_599(code: Any) -> None:
    with pytest.raises(ValueError, match="400-599"):
        RequestRejectedError(code, "x")


async def _first_beat_and_status(
    nc: NATSClient, name: str, provider: Callable[[], Mapping[str, object]]
) -> tuple[HeartbeatPayload, HeartbeatPayload]:
    beats: list[HeartbeatPayload] = []

    async def on_beat(msg: Msg) -> None:
        beats.append(HeartbeatPayload.model_validate_json(msg.data))

    sub = await nc.subscribe(f"agents.hb.icpt.o.{name}", cb=on_beat)
    await nc.flush()
    svc = await _start(nc, name, heartbeat_extras=provider)
    try:
        await wait_for(lambda: len(beats) == 1, what="the first heartbeat")
        reply = await nc.request(svc.subject.status, b"", timeout=2.0)
        status = HeartbeatPayload.model_validate_json(reply.data)
    finally:
        await sub.unsubscribe()
        await svc.stop()
    return beats[0], status


async def test_heartbeat_extras_ride_every_beat_and_status_reply(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    calls = 0

    def provider() -> Mapping[str, object]:
        nonlocal calls
        calls += 1
        return {"calls": calls, "role": "worker"}

    beat, status = await _first_beat_and_status(nc, "hb-extras", provider)
    evidence.write_json("heartbeat.json", beat.model_dump())
    evidence.write_json("status.json", status.model_dump())
    assert beat.extras == {"calls": 1, "role": "worker"}
    # Read when each payload is built: the status reply is a later read.
    assert status.extras == {"calls": 2, "role": "worker"}


def _raises() -> Mapping[str, object]:
    raise RuntimeError("provider down")


@pytest.mark.parametrize(
    "provider",
    [_raises, lambda: {"instance_id": "forged"}, lambda: {"unserialisable": object()}],
    ids=["raises", "reserved-key", "unserialisable"],
)
async def test_a_misbehaving_provider_costs_the_beat_its_extras_never_the_beat(
    nc: NATSClient, provider: Callable[[], Mapping[str, object]]
) -> None:
    beat, status = await _first_beat_and_status(nc, "hb-bad", provider)
    for payload in (beat, status):
        assert payload.extras == {}
        assert payload.instance_id != "forged"

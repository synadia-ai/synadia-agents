"""Prompt and request interceptors, end to end.

A generic lineage extension (``tests/harness/lineage.py``) built on the
public hooks alone does what an extension that tracks prompt lineage
across agents needs: a signed record before each prompt, two envelope
fields, the half-pair refusal, a root minted when absent, the scope bound
around the handler and inherited by a client used inside it, and counts on
the heartbeat. The TypeScript suite's ``interceptors.test.ts`` proves the
same on its side.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import pytest
from synadia_ai.agents import (
    Agent,
    Agents,
    DiscoverFilter,
    Envelope,
    HeartbeatPayload,
    Identity,
    NatsAgentError,
    PayloadTooLargeError,
    PromptExtras,
    PromptInterceptor,
    PromptInterceptorContext,
    ProtocolError,
    parse_sender_header,
    read_sender_header_value,
    signer_from_seed,
    verify_sender,
)

from synadia_ai.agent_service import (
    AgentService,
    CallNext,
    PromptStream,
    RequestInterceptor,
    RequestInterceptorContext,
    RequestRejectedError,
)
from tests.harness.lineage import NODE_FIELD, NODE_HEADER, ROOT_FIELD, Lineage, LineageScope
from tests.harness.wait import wait_for

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser, EvidenceFor, NkeyUser
    from tests.harness.evidence import EvidenceRecorder
    from tests.harness.nats_server import RunningServer

RECORDS = "lineage.records"


@dataclass(frozen=True, slots=True)
class Handled:
    scope: LineageScope | None
    envelope: Envelope


@dataclass(slots=True)
class World:
    nc: NATSClient
    observer: NATSClient
    alice: NkeyUser
    evidence: EvidenceRecorder
    services: list[AgentService]
    clients: list[Agents]

    async def host(
        self,
        lin: Lineage,
        name: str,
        *,
        extra: Sequence[RequestInterceptor] = (),
        on_prompt: Callable[[Handled], Awaitable[None]] | None = None,
        max_payload: str = "1MB",
    ) -> tuple[AgentService, list[Handled]]:
        handled: list[Handled] = []
        svc = AgentService(
            nc=self.nc,
            agent="lineage",
            owner="o",
            session_name=name,
            heartbeat_interval_s=3600,
            keepalive_interval_s=None,
            max_payload=max_payload,
            interceptors=[lin.host, *extra],
            heartbeat_extras=lin.heartbeat_extras,
        )

        async def handler(envelope: Envelope, stream: PromptStream) -> None:
            entry = Handled(scope=lin.current(), envelope=envelope)
            handled.append(entry)
            if on_prompt is not None:
                await on_prompt(entry)
            await stream.send("ok")

        svc.on_prompt(handler)
        await svc.start()
        self.services.append(svc)
        return svc, handled

    def caller(
        self,
        lin: Lineage | None,
        *,
        signed: bool = True,
        extra: Sequence[PromptInterceptor] = (),
    ) -> Agents:
        agents = Agents(
            nc=self.nc,
            identity=Identity(signer=signer_from_seed(self.alice.seed)) if signed else None,
            interceptors=[*([lin.caller] if lin is not None else []), *extra],
        )
        self.clients.append(agents)
        return agents


@pytest.fixture
async def world(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> Any:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    observer = await connect_nkey_user(nats_server_nkey, "alice")
    w = World(
        nc=nc,
        observer=observer,
        alice=identity_keys["alice"],
        evidence=await evidence_for(observer),
        services=[],
        clients=[],
    )
    try:
        yield w
    finally:
        for agents in w.clients:
            await agents.close()
        for svc in w.services:
            await svc.stop()


async def _handle(agents: Agents, svc: AgentService) -> Agent:
    found = await agents.discover(
        filter=DiscoverFilter(agent="lineage", session_name=svc.subject.session_name)
    )
    assert len(found) == 1, found
    return found[0]


async def _drain(agent: Agent, text: str, **kwargs: Any) -> None:
    async for _ in agent.prompt(text, **kwargs):
        pass


async def _capture(nc: NATSClient, subject: str) -> tuple[list[Msg], Callable[[], Awaitable[None]]]:
    msgs: list[Msg] = []

    async def cb(msg: Msg) -> None:
        msgs.append(msg)

    sub = await nc.subscribe(subject, cb=cb)
    await nc.flush()
    return msgs, sub.unsubscribe


def _record(msg: Msg) -> dict[str, Any]:
    record: dict[str, Any] = json.loads(msg.data)
    return record


async def _raw(nc: NATSClient, subject: str, body: dict[str, Any]) -> list[Msg]:
    """Every frame a hand-built request draws, up to and including the terminator."""
    inbox = nc.new_inbox()
    sub = await nc.subscribe(inbox)
    try:
        await nc.publish(subject, json.dumps(body).encode(), reply=inbox)
        frames: list[Msg] = []
        while True:
            msg = await asyncio.wait_for(sub.next_msg(), timeout=5.0)
            frames.append(msg)
            if msg.data == b"" and not msg.headers:
                return frames
    finally:
        await sub.unsubscribe()


async def test_a_signed_record_goes_out_before_the_prompt_and_the_pair_rides_the_envelope(
    world: World,
) -> None:
    lin = Lineage(RECORDS)
    svc, handled = await world.host(lin, "record")
    agents = world.caller(lin)
    order: list[str] = []

    async def on_record(_msg: Msg) -> None:
        order.append("record")

    async def on_prompt(_msg: Msg) -> None:
        order.append("prompt")

    records, stop = await _capture(world.observer, RECORDS)
    await world.observer.subscribe(RECORDS, cb=on_record)
    await world.observer.subscribe(svc.subject.prompt, cb=on_prompt)
    await world.observer.flush()
    try:
        await _drain(await _handle(agents, svc), "hello", context={"label": "call-7"})
        await wait_for(lambda: len(order) == 2 and len(records) == 1, what="record and prompt")
    finally:
        await stop()

    # The record is on the wire before the prompt it describes.
    assert order == ["record", "prompt"]
    msg = records[0]
    record = _record(msg)
    world.evidence.write_jsonl("records.jsonl", [record])
    # One id: the body's record_id, the signed nonce and Nats-Msg-Id.
    header = parse_sender_header(read_sender_header_value(msg.headers) or "")
    assert header is not None and header.nonce == record["record_id"]
    assert (msg.headers or {}).get("Nats-Msg-Id") == record["record_id"]
    # Signed by the caller's own identity, which the body names too.
    sender = verify_sender(msg, "stored")
    me = await agents.self_id()
    assert sender is not None and sender.trust == "verified" and sender.id == me
    assert record["agent"] == str(me)
    # A root: no ambient scope, so no parent and the node is its own root.
    assert record["parent"] is None
    assert record["root"] == record["node"]
    assert record["target"] == svc.instance_id
    assert record["label"] == "call-7"

    # The host adopted the pair from the envelope's unknown fields and ran
    # the handler inside it.
    assert len(handled) == 1
    assert handled[0].envelope.extras == {NODE_FIELD: record["node"], ROOT_FIELD: record["root"]}
    assert handled[0].scope == LineageScope(node=record["node"], root=record["root"])
    assert (lin.counts.published, lin.counts.dropped) == (1, 0)
    assert (lin.counts.adopted, lin.counts.minted) == (1, 0)


async def test_the_host_interceptor_sees_envelope_sender_subject_and_headers(
    world: World,
) -> None:
    lin = Lineage(RECORDS)
    seen: list[RequestInterceptorContext] = []

    class Spy:
        async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
            seen.append(ctx)
            await call_next()

    svc, handled = await world.host(lin, "ctx", extra=[Spy()])
    agents = world.caller(lin)
    await _drain(await _handle(agents, svc), "hi")
    assert len(seen) == 1
    ctx = seen[0]
    assert ctx.subject == svc.subject.prompt
    me = await agents.self_id()
    assert ctx.sender is not None and ctx.sender.trust == "verified" and ctx.sender.id == me
    node = handled[0].scope.node if handled[0].scope is not None else None
    assert ctx.headers.get(NODE_HEADER) == node
    assert ctx.envelope.prompt == "hi"
    assert ctx.envelope.extras.get(NODE_FIELD) == node


@pytest.mark.parametrize("field", [NODE_FIELD, ROOT_FIELD])
async def test_a_half_pair_is_a_400_before_the_ack_and_never_reaches_the_handler(
    world: World, field: str
) -> None:
    lin = Lineage(RECORDS)
    svc, handled = await world.host(lin, f"half-{field}")
    frames = await _raw(world.nc, svc.subject.prompt, {"prompt": "x", field: "a" * 32})
    # Error frame, then the terminator — no ack, no chunk.
    assert len(frames) == 2
    headers = frames[0].headers or {}
    assert headers.get("Nats-Service-Error-Code") == "400"
    assert "must be given together" in headers.get("Nats-Service-Error", "")
    assert frames[1].data == b"" and not frames[1].headers
    assert handled == []


async def test_a_root_is_minted_when_the_envelope_carries_no_pair(world: World) -> None:
    lin = Lineage(RECORDS)
    svc, handled = await world.host(lin, "mint")
    plain = world.caller(None, signed=False)
    await _drain(await _handle(plain, svc), "plain")
    scope = handled[0].scope
    assert scope is not None and len(scope.node) == 32 and scope.root == scope.node
    assert handled[0].envelope.extras == {}
    assert (lin.counts.adopted, lin.counts.minted) == (0, 1)


async def test_a_client_used_inside_the_handler_inherits_the_scope(world: World) -> None:
    lin = Lineage(RECORDS)
    inner_svc, inner_handled = await world.host(lin, "inner")
    inner_client = world.caller(lin)

    async def nested(_handled: Handled) -> None:
        await _drain(await _handle(inner_client, inner_svc), "nested")

    outer_svc, outer_handled = await world.host(lin, "outer", on_prompt=nested)
    outer_client = world.caller(lin)
    records, stop = await _capture(world.observer, RECORDS)
    try:
        await _drain(await _handle(outer_client, outer_svc), "top")
        await wait_for(lambda: len(records) == 2, what="two records")
    finally:
        await stop()
    top, child = (_record(m) for m in records)
    world.evidence.write_jsonl("records.jsonl", [top, child])
    outer_scope = outer_handled[0].scope
    assert outer_scope is not None
    # The nested prompt is a child of the outer execution, in its tree.
    assert top["node"] == outer_scope.node
    assert child["parent"] == outer_scope.node
    assert child["root"] == outer_scope.root
    assert inner_handled[0].scope == LineageScope(node=child["node"], root=outer_scope.root)


async def test_it_runs_in_the_context_prompt_was_called_in(world: World) -> None:
    lin = Lineage(RECORDS)
    svc, handled = await world.host(lin, "context")
    agents = world.caller(lin)
    agent = await _handle(agents, svc)
    records, stop = await _capture(world.observer, RECORDS)
    parent = LineageScope(node="b" * 32, root="c" * 32)
    try:
        with lin.within(parent):
            stream = agent.prompt("later")
        # Iterated inside another scope altogether.
        with lin.within(LineageScope(node="d" * 32, root="d" * 32)):
            async for _ in stream:
                pass
        await wait_for(lambda: len(records) == 1, what="one record")
    finally:
        await stop()
    record = _record(records[0])
    assert record["parent"] == parent.node
    assert record["root"] == parent.root
    assert handled[0].scope == LineageScope(node=record["node"], root=parent.root)


async def test_a_prompt_that_is_never_iterated_runs_no_interceptor(world: World) -> None:
    lin = Lineage(RECORDS)
    svc, handled = await world.host(lin, "idle")
    agents = world.caller(lin)
    records, stop = await _capture(world.observer, RECORDS)
    try:
        stream = (await _handle(agents, svc)).prompt("never sent")
        await asyncio.sleep(0.3)
        await stream.aclose()  # type: ignore[attr-defined]
    finally:
        await stop()
    assert records == []
    assert handled == []
    assert (lin.counts.published, lin.counts.dropped) == (0, 0)


async def test_without_a_signer_the_record_is_dropped_and_the_pair_still_sent(
    world: World,
) -> None:
    lin = Lineage(RECORDS)
    svc, handled = await world.host(lin, "unsigned")
    agents = world.caller(lin, signed=False)
    await _drain(await _handle(agents, svc), "unsigned")
    assert (lin.counts.published, lin.counts.dropped, lin.counts.adopted) == (0, 1, 1)
    assert handled[0].scope is not None


async def test_the_counts_ride_every_heartbeat_and_status_reply(world: World) -> None:
    lin = Lineage(RECORDS)
    svc, _ = await world.host(lin, "counts")
    signed = world.caller(lin)
    unsigned = world.caller(lin, signed=False)
    await _drain(await _handle(signed, svc), "one")
    await _drain(await _handle(unsigned, svc), "two")
    status = await (await _handle(signed, svc)).status()
    assert status.extras == {"lineage_published": 1, "lineage_dropped": 1}

    # The heartbeat reads the provider when each beat is built.
    beats: list[HeartbeatPayload] = []

    async def on_beat(msg: Msg) -> None:
        beats.append(HeartbeatPayload.model_validate_json(msg.data))

    await world.observer.subscribe("agents.hb.lineage.o.counts-hb", cb=on_beat)
    await world.observer.flush()
    beating = AgentService(
        nc=world.nc,
        agent="lineage",
        owner="o",
        session_name="counts-hb",
        heartbeat_interval_s=3600,
        heartbeat_extras=lin.heartbeat_extras,
    )

    async def idle(_env: Envelope, _stream: PromptStream) -> None:
        return None

    beating.on_prompt(idle)
    await beating.start()
    world.services.append(beating)
    await wait_for(lambda: len(beats) == 1, what="the first heartbeat")
    world.evidence.write_json("heartbeat.json", beats[0].model_dump())
    assert beats[0].extras == {"lineage_published": 1, "lineage_dropped": 1}


async def test_an_interceptor_that_raises_fails_the_prompt_and_nothing_is_sent(
    world: World,
) -> None:
    lin = Lineage(RECORDS)
    svc, handled = await world.host(lin, "raises")

    class Failing:
        async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
            raise RuntimeError("interceptor says no")

    agents = world.caller(None, extra=[Failing()])
    with pytest.raises(RuntimeError, match="interceptor says no"):
        await _drain(await _handle(agents, svc), "x")
    await asyncio.sleep(0.2)
    assert handled == []


async def test_a_protocol_field_or_the_agent_sender_header_is_refused(world: World) -> None:
    lin = Lineage(RECORDS)
    svc, _ = await world.host(lin, "reserved")

    class Field:
        async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
            return PromptExtras(fields={"prompt": "hijack"})

    class Header:
        async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
            return PromptExtras(headers={"agent-sender": "{}"})

    with pytest.raises(NatsAgentError, match="envelope field"):
        await _drain(await _handle(world.caller(None, extra=[Field()]), svc), "x")
    with pytest.raises(NatsAgentError, match="Agent-Sender header"):
        await _drain(await _handle(world.caller(None, extra=[Header()]), svc), "x")


async def test_several_interceptors_merge_in_order_the_later_one_winning_a_key(
    world: World,
) -> None:
    lin = Lineage(RECORDS)
    svc, handled = await world.host(lin, "merge")

    class Adds:
        def __init__(self, fields: dict[str, object] | None) -> None:
            self._fields = fields

        async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
            return PromptExtras(fields=self._fields) if self._fields is not None else None

    agents = world.caller(
        None,
        signed=False,
        extra=[Adds({"a": 1, "shared": "first"}), Adds(None), Adds({"b": 2, "shared": "second"})],
    )
    await _drain(await _handle(agents, svc), "x")
    # The host minted: the fields are unknown to the lineage pair.
    assert handled[0].envelope.extras == {"a": 1, "b": 2, "shared": "second"}


async def test_a_request_rejected_error_answers_its_code(world: World) -> None:
    lin = Lineage(RECORDS)

    class Deny:
        async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
            raise RequestRejectedError(403, "not you")

    svc, handled = await world.host(lin, "deny", extra=[Deny()])
    agents = world.caller(lin)
    with pytest.raises(ProtocolError, match="service error 403: not you"):
        await _drain(await _handle(agents, svc), "x")
    assert handled == []


async def test_a_prompt_that_fails_the_size_check_publishes_nothing(world: World) -> None:
    lin = Lineage(RECORDS)
    # 1 KB: the prompt alone fits with room for its header; with a bulky
    # extra field it no longer does, which only the check made at publish
    # time — after the first phase, before the second — can see.
    svc, handled = await world.host(lin, "too-big", max_payload="1KB")

    class Bulky:
        async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
            return PromptExtras(fields={"x_bulk": "b" * 2_000})

    agents = world.caller(lin, extra=[Bulky()])
    records, stop_records = await _capture(world.observer, RECORDS)
    prompts, stop_prompts = await _capture(world.observer, svc.subject.prompt)
    try:
        with pytest.raises(PayloadTooLargeError):
            await _drain(await _handle(agents, svc), "hi")
        await asyncio.sleep(0.3)
    finally:
        await stop_records()
        await stop_prompts()
    assert records == []
    assert prompts == []
    assert handled == []
    assert (lin.counts.published, lin.counts.dropped) == (0, 0)


async def test_before_publish_gets_the_same_context_and_what_before_prompt_returned(
    world: World,
) -> None:
    lin = Lineage(RECORDS)
    svc, _ = await world.host(lin, "phases")
    seen: list[tuple[str, PromptInterceptorContext, PromptExtras | None]] = []
    state = {"planned": "by phase one"}
    returned = PromptExtras(fields={"x_phase": 1}, state=state)

    class Phases:
        async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
            seen.append(("before_prompt", ctx, None))
            return returned

        async def before_publish(
            self, ctx: PromptInterceptorContext, extras: PromptExtras | None
        ) -> None:
            seen.append(("before_publish", ctx, extras))

    class Silent:
        async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
            return None

        async def before_publish(
            self, ctx: PromptInterceptorContext, extras: PromptExtras | None
        ) -> None:
            seen.append(("silent", ctx, extras))

    agents = world.caller(None, extra=[Phases(), Silent()])
    await _drain(await _handle(agents, svc), "hi", context={"k": "v"})
    assert [phase for phase, _, _ in seen] == ["before_prompt", "before_publish", "silent"]
    assert seen[1][1] is seen[0][1]
    assert seen[2][1] is seen[0][1]
    assert seen[1][2] is returned
    assert seen[1][2] is not None and seen[1][2].state is state
    assert seen[2][2] is None
    assert dict(seen[0][1].context) == {"k": "v"}


async def test_a_before_publish_failure_is_logged_and_the_prompt_still_goes_out(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    lin = Lineage(RECORDS)
    svc, handled = await world.host(lin, "phase-two-raises")

    class Failing:
        async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
            return None

        async def before_publish(
            self, ctx: PromptInterceptorContext, extras: PromptExtras | None
        ) -> None:
            raise RuntimeError("secret detail")

    agents = Agents(
        nc=world.nc,
        identity=Identity(signer=signer_from_seed(world.alice.seed)),
        interceptors=[Failing(), lin.caller],
    )
    world.clients.append(agents)
    with caplog.at_level(logging.ERROR, logger="synadia_ai.agents"):
        await _drain(await _handle(agents, svc), "still sent")
    # The prompt went out, and the interceptor after the failing one ran.
    assert len(handled) == 1
    assert (lin.counts.published, lin.counts.dropped) == (1, 0)
    failures = [r for r in caplog.records if "before_publish failed" in r.getMessage()]
    assert len(failures) == 1
    assert "secret detail" not in caplog.text

"""``AgentService(extra_endpoints=…)``: harness endpoints on the agent's micro service.

Parity with the TypeScript host's ``extraEndpoints``: registered after
``prompt`` and ``status`` in the order given, each on its subject as given,
with its metadata on ``$SRV.INFO`` (evidence: ``srv-info.json``). An
endpoint without a ``queue`` gets the framework's default queue group,
``"q"`` — nats-py's, and ``@nats-io/services``' in the TypeScript host,
whose ``AgentService`` sets no service-level group — so two instances on
the same subject share its requests with or without one. The broker's own
view of the subscriptions (``/subsz``: queue group, deliveries) is the
evidence for that (``broker-subsz.json``). Names are checked at
construction, so a refused entry leaves nothing registered.
"""

from __future__ import annotations

import asyncio
import json
import urllib.parse
import urllib.request
from typing import TYPE_CHECKING, Any, cast
from unittest.mock import MagicMock

import nats
import pytest
from nats.errors import NoRespondersError
from synadia_ai.agents import (
    MIN_SENDER_TRUST_KEY,
    PROMPT_QUEUE_GROUP,
    STATUS_QUEUE_GROUP,
    AgentSubject,
    Envelope,
)

from synadia_ai.agent_service import (
    DEFAULT_MIN_SENDER_TRUST,
    AgentService,
    AgentServiceExtraEndpoint,
    PromptStream,
)
from tests.harness.wait import wait_for

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.micro.service import Request

    from tests.harness.evidence import EvidenceRecorder
    from tests.harness.nats_server import RunningServer

AGENT = "extra-ep"
OWNER = "pytest-extra"


def _subject(verb: str, session_name: str) -> str:
    """A harness subject under the protocol's namespace, assembled by the harness."""
    return f"agents.{verb}.{AGENT}.{OWNER}.{session_name}"


async def _noop(envelope: Envelope, stream: PromptStream) -> None:
    del envelope, stream


async def _answer_ok(request: Request) -> None:
    await request.respond(b"ok")


def _service(
    nc: NATSClient, session_name: str, extra_endpoints: list[AgentServiceExtraEndpoint]
) -> AgentService:
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name=session_name,
        nc=nc,
        heartbeat_interval_s=30,
        extra_endpoints=extra_endpoints,
    )
    service.on_prompt(_noop)
    return service


async def _srv_info(nc: NATSClient, prompt_subject: str) -> dict[str, Any]:
    """The ``$SRV.INFO`` record of the instance serving ``prompt_subject``."""
    inbox = nc.new_inbox()
    sub = await nc.subscribe(inbox)
    await nc.publish("$SRV.INFO.agents", b"", reply=inbox)
    while True:
        msg = await sub.next_msg(timeout=2.0)
        record: dict[str, Any] = json.loads(msg.data)
        if any(
            ep["name"] == "prompt" and ep["subject"] == prompt_subject for ep in record["endpoints"]
        ):
            await sub.unsubscribe()
            return record


def _broker_subs(server: RunningServer, subject: str) -> list[dict[str, Any]]:
    """The broker's subscriptions on exactly ``subject``, from ``/subsz``.

    Each carries the connection (``cid``), the queue group (``qgroup``,
    absent without one) and the messages delivered to it (``msgs``).
    ``test`` also matches wildcard subscriptions, such as the evidence
    recorder's spy, so those are left out. Synchronous: one cold GET
    against a localhost server.
    """
    query = urllib.parse.urlencode({"subs": 1, "test": subject})
    with urllib.request.urlopen(f"{server.monitoring_url}/subsz?{query}", timeout=2.0) as resp:
        subsz = cast("dict[str, Any]", json.loads(resp.read()))
    return [sub for sub in subsz.get("subscriptions_list") or [] if sub["subject"] == subject]


async def test_an_extra_endpoint_answers_a_request(nc: NATSClient) -> None:
    subject = _subject("spawn", "answers")

    async def spawn(request: Request) -> None:
        await request.respond(b"spawned " + request.data)

    service = _service(
        nc,
        "answers",
        [AgentServiceExtraEndpoint(name="spawn", subject=subject, handler=spawn)],
    )
    await service.start()
    try:
        reply = await nc.request(subject, b"worker-1", timeout=2.0)
        assert reply.data == b"spawned worker-1"
    finally:
        await service.stop()


async def test_srv_info_lists_them_after_prompt_and_status(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    spawn_subject = _subject("spawn", "info")
    list_subject = _subject("list", "info")
    spawn_metadata = {"role": "controller"}
    service = _service(
        nc,
        "info",
        [
            AgentServiceExtraEndpoint(
                name="spawn",
                subject=spawn_subject,
                handler=_answer_ok,
                queue="controllers",
                metadata=spawn_metadata,
            ),
            AgentServiceExtraEndpoint(name="list", subject=list_subject, handler=_answer_ok),
        ],
    )
    # The service holds its own copy: a later mutation changes nothing registered.
    spawn_metadata["role"] = "mutated"
    await service.start()
    try:
        record = await _srv_info(nc, service.subject.prompt)
        evidence.write_json("srv-info.json", record)
        endpoints = record["endpoints"]
        assert [ep["name"] for ep in endpoints] == ["prompt", "status", "spawn", "list"]
        spawn, listing = endpoints[2], endpoints[3]
        assert spawn["subject"] == spawn_subject  # as given: no prefix
        assert spawn["queue_group"] == "controllers"
        assert spawn["metadata"] == {"role": "controller"}
        assert listing["subject"] == list_subject
        assert listing["queue_group"] == "q"  # the framework default, as in TypeScript
        assert listing["metadata"] is None
    finally:
        await service.stop()


@pytest.mark.parametrize(
    ("queue", "group"),
    [("controllers", "controllers"), (None, "q")],
    ids=["own-queue-group", "default-queue-group"],
)
async def test_two_instances_share_the_queue_group(
    nats_server: RunningServer,
    nc: NATSClient,
    evidence: EvidenceRecorder,
    queue: str | None,
    group: str,
) -> None:
    """Each request reaches one of the two instances: the broker delivers it once.

    The broker counts a delivery (``msgs``) as it routes the request, every
    delivery of that request in the same pass, so once all N replies are in
    the counts are final: N deliveries across both instances, where two
    instances outside a shared group would have had 2N. (Not after a
    ``flush()``: nats-py 2.14 writes its PING ahead of publishes still
    waiting for its flusher.)
    """
    subject = _subject("list", f"shared-{group}")
    requests = 20

    def endpoint(tag: str) -> AgentServiceExtraEndpoint:
        async def handler(request: Request) -> None:
            await request.respond(tag.encode())

        return AgentServiceExtraEndpoint(name="list", subject=subject, handler=handler, queue=queue)

    nc_a = await nats.connect(nats_server.url)
    nc_b = await nats.connect(nats_server.url)
    service_a = _service(nc_a, f"shared-{group}", [endpoint("a")])
    service_b = _service(nc_b, f"shared-{group}", [endpoint("b")])
    try:
        await service_a.start()
        await service_b.start()
        await wait_for(
            lambda: len(_broker_subs(nats_server, subject)) == 2,
            what="a subscription per instance at the broker",
        )
        subs = _broker_subs(nats_server, subject)
        assert len({sub["cid"] for sub in subs}) == 2  # one per instance
        assert all(sub.get("qgroup") == group for sub in subs)

        inbox = nc.new_inbox()
        replies = await nc.subscribe(inbox)
        for index in range(requests):
            await nc.publish(subject, str(index).encode(), reply=inbox)
        served_by = [(await replies.next_msg(timeout=2.0)).data.decode() for _ in range(requests)]
        await replies.unsubscribe()

        subs = _broker_subs(nats_server, subject)
        evidence.write_json("broker-subsz.json", {"subscriptions": subs, "served_by": served_by})
        assert sum(sub["msgs"] for sub in subs) == requests
        assert set(served_by) <= {"a", "b"}
    finally:
        await service_a.stop()
        await service_b.stop()
        await nc_a.close()
        await nc_b.close()


@pytest.mark.parametrize(
    ("names", "message"),
    [
        (["prompt"], r"extra_endpoints\[0\]\.name='prompt' is the name of an endpoint"),
        (["status"], r"extra_endpoints\[0\]\.name='status' is the name of an endpoint"),
        (
            ["spawn", "spawn"],
            r"extra_endpoints\[1\]\.name='spawn' is already the name of extra_endpoints\[0\]",
        ),
    ],
    ids=["prompt", "status", "duplicate"],
)
async def test_a_reserved_or_repeated_name_raises_before_anything_is_registered(
    nats_server: RunningServer, nc: NATSClient, names: list[str], message: str
) -> None:
    session_name = f"refused-{'-'.join(names)}"
    protocol = AgentSubject.new(agent=AGENT, owner=OWNER, session_name=session_name)
    extra_subject = _subject("custom", session_name)
    entries = [
        AgentServiceExtraEndpoint(name=name, subject=extra_subject, handler=_answer_ok)
        for name in names
    ]
    services_before = len(_broker_subs(nats_server, "$SRV.PING.agents"))
    with pytest.raises(ValueError, match=message):
        AgentService(
            agent=AGENT,
            owner=OWNER,
            session_name=session_name,
            nc=nc,
            extra_endpoints=entries,
        )
    # Nothing reached the broker: no endpoint, and no service's control subscription.
    for subject in (protocol.prompt, protocol.status, extra_subject):
        assert _broker_subs(nats_server, subject) == []
    assert len(_broker_subs(nats_server, "$SRV.PING.agents")) == services_before


async def test_without_extra_endpoints_the_registration_is_unchanged(nc: NATSClient) -> None:
    """``prompt`` and ``status`` exactly, whether the option is omitted or empty."""
    omitted = AgentService(
        agent=AGENT, owner=OWNER, session_name="omitted", nc=nc, heartbeat_interval_s=30
    )
    empty = _service(nc, "empty", [])
    omitted.on_prompt(_noop)
    await omitted.start()
    await empty.start()
    try:
        for service in (omitted, empty):
            subject = service.subject
            record = await _srv_info(nc, subject.prompt)
            assert record["endpoints"] == [
                {
                    "name": "prompt",
                    "subject": subject.prompt,
                    "queue_group": PROMPT_QUEUE_GROUP,
                    "metadata": {
                        "max_payload": "1MB",
                        "attachments_ok": "true",
                        MIN_SENDER_TRUST_KEY: DEFAULT_MIN_SENDER_TRUST,
                    },
                },
                {
                    "name": "status",
                    "subject": subject.status,
                    "queue_group": STATUS_QUEUE_GROUP,
                    "metadata": None,
                },
            ]
    finally:
        await omitted.stop()
        await empty.stop()


async def test_stop_removes_them(nats_server: RunningServer, nc: NATSClient) -> None:
    subject = _subject("spawn", "stopped")
    service = _service(
        nc,
        "stopped",
        [AgentServiceExtraEndpoint(name="spawn", subject=subject, handler=_answer_ok)],
    )
    await service.start()
    assert (await nc.request(subject, b"", timeout=2.0)).data == b"ok"
    assert len(_broker_subs(nats_server, subject)) == 1

    await service.stop()
    await wait_for(
        lambda: _broker_subs(nats_server, subject) == [],
        what="the endpoint's subscription gone from the broker",
    )
    with pytest.raises(NoRespondersError):
        await nc.request(subject, b"", timeout=2.0)


async def test_an_endpoint_serves_its_requests_in_turn(nc: NATSClient) -> None:
    """nats-py awaits the handler before the endpoint's next request.

    ``max_concurrent_prompts`` does not reach it, and it holds up neither
    ``status`` nor another endpoint: each has a subscription of its own.
    """
    subject = _subject("spawn", "in-turn")
    events: list[str] = []
    first_started = asyncio.Event()
    release_first = asyncio.Event()

    async def spawn(request: Request) -> None:
        events.append(f"start {request.data.decode()}")
        if request.data == b"1":
            first_started.set()
            await release_first.wait()
        events.append(f"end {request.data.decode()}")
        await request.respond(request.data)

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="in-turn",
        nc=nc,
        heartbeat_interval_s=30,
        max_concurrent_prompts=4,
        extra_endpoints=[
            AgentServiceExtraEndpoint(name="spawn", subject=subject, handler=spawn),
            AgentServiceExtraEndpoint(
                name="list", subject=_subject("list", "in-turn"), handler=_answer_ok
            ),
        ],
    )
    service.on_prompt(_noop)
    await service.start()
    try:
        first = asyncio.create_task(nc.request(subject, b"1", timeout=5.0))
        await asyncio.wait_for(first_started.wait(), timeout=2.0)
        second = asyncio.create_task(nc.request(subject, b"2", timeout=5.0))
        # The first handler is still waiting: status and the other endpoint answer.
        await nc.request(service.subject.status, b"", timeout=2.0)
        assert (await nc.request(_subject("list", "in-turn"), b"", timeout=2.0)).data == b"ok"
        assert events == ["start 1"]

        release_first.set()
        assert (await first).data == b"1"
        assert (await second).data == b"2"
        assert events == ["start 1", "end 1", "start 2", "end 2"]
    finally:
        await service.stop()


async def test_a_handler_exception_is_answered_500_by_nats_py(nc: NATSClient) -> None:
    """What the dataclass documents: nats-py's reply, with the exception's ``repr()``."""
    subject = _subject("spawn", "raises")

    async def spawn(request: Request) -> None:
        del request
        raise RuntimeError("no capacity")

    service = _service(
        nc,
        "raises",
        [AgentServiceExtraEndpoint(name="spawn", subject=subject, handler=spawn)],
    )
    await service.start()
    try:
        reply = await nc.request(subject, b"", timeout=2.0)
        assert reply.headers is not None
        assert reply.headers["Nats-Service-Error-Code"] == "500"
        assert reply.headers["Nats-Service-Error"] == "RuntimeError('no capacity')"
    finally:
        await service.stop()


class TestValidation:
    """The constructor's checks, which need no broker."""

    @staticmethod
    def _build(extra_endpoints: Any) -> AgentService:
        return AgentService(
            agent=AGENT,
            owner=OWNER,
            session_name="unit",
            nc=MagicMock(),
            extra_endpoints=extra_endpoints,
        )

    @pytest.mark.parametrize("extra_endpoints", [(), []], ids=["tuple", "list"])
    def test_accepts_no_entries(self, extra_endpoints: Any) -> None:
        self._build(extra_endpoints)

    def test_the_type_is_frozen(self) -> None:
        endpoint = AgentServiceExtraEndpoint(name="spawn", subject="s", handler=_answer_ok)
        with pytest.raises(AttributeError):
            endpoint.name = "other"  # type: ignore[misc]

    def test_rejects_an_entry_of_another_type(self) -> None:
        with pytest.raises(
            TypeError, match=r"extra_endpoints\[0\] must be an AgentServiceExtraEndpoint; got dict"
        ):
            self._build([{"name": "spawn", "subject": "s", "handler": _answer_ok}])

    def test_rejects_a_handler_that_is_not_callable(self) -> None:
        endpoint = AgentServiceExtraEndpoint(
            name="spawn",
            subject="s",
            handler=None,  # type: ignore[arg-type]
        )
        with pytest.raises(TypeError, match=r"extra_endpoints\[0\]\.handler must be an async"):
            self._build([endpoint])

    @pytest.mark.parametrize(
        ("name", "subject", "queue", "message"),
        [
            ("has space", "s", None, "Invalid name"),
            ("spawn", "a b", None, "Invalid subject"),
            ("spawn", "s", "a b", "Invalid queue group"),
        ],
        ids=["name", "subject", "queue"],
    )
    def test_rejects_what_nats_py_refuses_and_names_the_entry(
        self, name: str, subject: str, queue: str | None, message: str
    ) -> None:
        entries = [
            AgentServiceExtraEndpoint(name="ok", subject="ok", handler=_answer_ok),
            AgentServiceExtraEndpoint(name=name, subject=subject, handler=_answer_ok, queue=queue),
        ]
        with pytest.raises(ValueError, match=rf"extra_endpoints\[1\] \(name={name!r}\): {message}"):
            self._build(entries)

    def test_rejects_metadata_that_is_not_a_mapping(self) -> None:
        with pytest.raises(
            TypeError, match=r"extra_endpoints\[0\]\.metadata must be a Mapping\[str, str\] or None"
        ):
            self._build(
                [
                    AgentServiceExtraEndpoint(
                        name="spawn",
                        subject="s",
                        handler=_answer_ok,
                        metadata=[("role", "controller")],  # type: ignore[arg-type]
                    )
                ]
            )

    def test_rejects_a_non_str_metadata_value_and_names_its_key(self) -> None:
        endpoint = AgentServiceExtraEndpoint(
            name="spawn",
            subject="s",
            handler=_answer_ok,
            metadata={"token": b"s3cr3t-value"},  # type: ignore[dict-item]
        )
        with pytest.raises(TypeError) as exc_info:
            self._build([endpoint])
        message = str(exc_info.value)
        assert message.startswith("extra_endpoints[0].metadata['token'] must be a str; got bytes")
        assert "s3cr3t" not in message  # the value itself is never echoed

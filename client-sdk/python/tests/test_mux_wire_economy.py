"""Wire-economy regression: one SUB per :class:`Agents`, not one per prompt.

The interim mux inbox (`src/synadia_ai/agents/_mux.py`) exists to cut
SUB+flush traffic from one-per-prompt to one-per-:class:`Agents`. That's
the load-bearing observable consequence of PR #66 / TS PR-66-Python-
catch-up — assert it directly so a regression to the per-prompt
``subscribe + publish`` pattern shows up as a test failure rather than
a silent perf regression.

Two layers of evidence:

1. :func:`test_five_prompts_open_one_mux_subscription` — instruments
   the SDK's ``nc.subscribe`` callsite. Fast, deterministic, fails on
   any code path that adds a per-prompt SDK-level subscribe call.
2. :func:`test_broker_sees_one_mux_subscription_for_n_prompts` — hits
   the broker's HTTP monitoring ``/subsz`` endpoint and asserts the
   subscription count under the mux's exact inbox prefix. Catches a
   subtler regression where some hand-rolled path bypasses
   ``nc.subscribe`` (e.g. constructs a ``Subscription`` directly via
   internal nats-py API). The HTTP endpoint is enabled unconditionally
   by :func:`tests.harness.nats_server.start_server`.
"""

from __future__ import annotations

import asyncio
import gc
import json
import urllib.request
import weakref
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, cast

from synadia_ai.agents import (
    Agent,
    AgentInfo,
    Agents,
    EndpointInfo,
    ResponseChunk,
)
from synadia_ai.agents._mux import _MUX_CACHE, mux_for

if TYPE_CHECKING:
    from collections.abc import Callable

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.harness.evidence import EvidenceRecorder
    from tests.harness.nats_server import RunningServer

    BgTasks = Callable[[asyncio.Task[object]], None]


PROMPT_SUBJECT = "agents.prompt.test-agent.pytest.wireecon"


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
        session_name="wireecon",
        protocol_version="0.3",
        description="",
        version="0.0.0",
        metadata=MappingProxyType({"agent": "test-agent", "owner": "pytest"}),
        endpoints=(prompt_endpoint,),
        prompt_endpoint=prompt_endpoint,
    )


def _response_chunk(text: str) -> bytes:
    return json.dumps({"type": "response", "data": text}).encode("utf-8")


class _WeakrefableClient:
    pass


def test_mux_cache_does_not_keep_dropped_client_alive() -> None:
    """The weak-keyed mux cache must not retain closed/dropped Clients."""
    client = _WeakrefableClient()
    client_ref = weakref.ref(client)
    mux = mux_for(cast("NATSClient", client))

    assert mux_for(cast("NATSClient", client)) is mux

    del client
    for _ in range(5):
        gc.collect()
        # Touch the weak dictionary so pending removals are committed.
        list(_MUX_CACHE.items())
        if client_ref() is None:
            break

    assert client_ref() is None
    assert all(cached is not mux for cached in _MUX_CACHE.values())


async def test_five_prompts_open_one_mux_subscription(
    nc: NATSClient, evidence: EvidenceRecorder, bg_tasks: BgTasks
) -> None:
    """A 5-prompt sequence opens exactly ONE inbox subscription (the mux).

    Pre-PR every prompt called ``await nc.subscribe(reply)`` for its
    own one-shot inbox — five prompts → five SUBs. After the mux
    refactor a single ``_INBOX.agents.<mux>.*`` SUB covers all five
    streams.

    To count SUBs we count entries to the mux inbox prefix in
    ``messages.jsonl``... actually nats-py doesn't echo SUB frames. We
    instrument ``nc.subscribe`` directly and tag inbox subscriptions
    via the subject prefix.
    """

    inbox_subscribes: list[str] = []
    original_subscribe = nc.subscribe

    async def counting_subscribe(subject: str, *args: object, **kwargs: object) -> object:
        if subject.startswith("_INBOX.agents."):
            inbox_subscribes.append(subject)
        return await original_subscribe(subject, *args, **kwargs)  # type: ignore[arg-type]

    nc.subscribe = counting_subscribe  # type: ignore[method-assign,assignment]

    async def echo_agent(msg: Msg) -> None:
        async def emit() -> None:
            await nc.publish(msg.reply, _response_chunk("ok"))
            await nc.publish(msg.reply, b"")  # terminator

        bg_tasks(asyncio.create_task(emit()))

    sub = await original_subscribe(PROMPT_SUBJECT, cb=echo_agent)
    try:
        agents = Agents(nc=nc)
        info = _make_agent_info(PROMPT_SUBJECT)
        agent = Agent(nc, info, close_event=agents.close_event)

        # Snapshot pre-prompt count so we don't conflate other
        # subscriptions opened by the test harness/agents.
        baseline = len(inbox_subscribes)

        for i in range(5):
            received: list[str] = []
            async for chunk in agent.prompt(f"prompt-{i}"):
                if isinstance(chunk, ResponseChunk):
                    received.append(chunk.text)
            assert received == ["ok"], f"prompt {i} got unexpected chunks: {received!r}"

        opened_during_prompts = inbox_subscribes[baseline:]
        await agents.close()
    finally:
        await sub.unsubscribe()
        nc.subscribe = original_subscribe  # type: ignore[method-assign]

    # Exactly ONE inbox SUB during the 5-prompt sequence — the mux.
    assert len(opened_during_prompts) == 1, (
        f"expected 1 mux inbox SUB across 5 prompts; opened {len(opened_during_prompts)}: "
        f"{opened_during_prompts!r}"
    )
    # Sanity: it really does live under the SDK inbox prefix.
    assert opened_during_prompts[0].startswith("_INBOX.agents.")
    evidence.write_json(
        "sub_count.json",
        {"prompts": 5, "inbox_subs_opened": len(opened_during_prompts)},
    )


def _fetch_subsz(monitoring_url: str) -> dict[str, Any]:
    """Synchronous GET of the broker's ``/subsz?subs=1`` endpoint.

    Synchronous because :mod:`urllib.request` doesn't need an event
    loop and the call is sub-millisecond against a localhost server.
    Avoids dragging in :mod:`aiohttp` for one cold poll.
    """
    with urllib.request.urlopen(f"{monitoring_url}/subsz?subs=1", timeout=2.0) as response:
        return cast("dict[str, Any]", json.loads(response.read()))


async def test_broker_sees_one_mux_subscription_for_n_prompts(
    nats_server: RunningServer,
    nc: NATSClient,
    evidence: EvidenceRecorder,
    bg_tasks: BgTasks,
) -> None:
    """Broker-observed truth: exactly one SUB under this mux's inbox prefix.

    Complements :func:`test_five_prompts_open_one_mux_subscription` by
    asking the broker — not the SDK — how many subscriptions actually
    exist for the mux's inbox prefix during a multi-prompt sequence.
    A regression that bypasses ``nc.subscribe`` (hand-rolled
    :class:`~nats.aio.subscription.Subscription`, or any future code
    path that registers SUBs without going through ``nc.subscribe``)
    would fool the SDK-instrumented test but not this one.

    We filter by the mux's exact ``inbox_prefix`` (one nuid per
    connection) so other tests' lingering subs and the test
    harness's evidence-recorder ``_INBOX.>`` cannot be conflated
    with this connection's mux.
    """
    n_prompts = 5

    async def echo_agent(msg: Msg) -> None:
        async def emit() -> None:
            await nc.publish(msg.reply, _response_chunk("ok"))
            await nc.publish(msg.reply, b"")  # terminator

        bg_tasks(asyncio.create_task(emit()))

    sub = await nc.subscribe(PROMPT_SUBJECT, cb=echo_agent)
    try:
        agents = Agents(nc=nc)
        info = _make_agent_info(PROMPT_SUBJECT)
        agent = Agent(nc, info, close_event=agents.close_event)

        for i in range(n_prompts):
            received: list[str] = []
            async for chunk in agent.prompt(f"prompt-{i}"):
                if isinstance(chunk, ResponseChunk):
                    received.append(chunk.text)
            assert received == ["ok"], f"prompt {i} got unexpected chunks: {received!r}"

        # Flush the connection so every SUB/UNSUB has reached the broker
        # before we poll, otherwise the broker's view can lag the SDK's.
        await nc.flush()

        # Mux-instance prefix — unique per connection. Filtering by the
        # exact prefix means other tests' lingering subs, the
        # evidence-recorder `_INBOX.>`, and any future test running in
        # parallel cannot inflate the count.
        mux_prefix = mux_for(nc).inbox_prefix
        subsz = _fetch_subsz(nats_server.monitoring_url)
        all_subs = subsz.get("subscriptions_list", []) or subsz.get("subscriptions", [])
        mux_subs = [
            entry
            for entry in all_subs
            if isinstance(entry, dict) and str(entry.get("subject", "")).startswith(mux_prefix)
        ]

        await agents.close()
    finally:
        await sub.unsubscribe()

    assert len(mux_subs) == 1, (
        f"broker reports {len(mux_subs)} subscription(s) under mux prefix "
        f"{mux_prefix!r} — expected exactly 1 (the mux). Subs: {mux_subs!r}"
    )
    # Tighter than just "starts with the prefix": the one subscription
    # MUST be the wildcard ``<mux_prefix>.*`` itself. A regression that
    # opened a per-prompt SUB on ``<mux_prefix>.<token>`` and
    # unsubscribed before our poll would still match the prefix filter
    # by accident; this assertion catches that failure mode by
    # demanding the exact wildcard form.
    assert mux_subs[0].get("subject") == f"{mux_prefix}.*", (
        f"expected mux SUB to be wildcard {mux_prefix}.*; got {mux_subs[0].get('subject')!r}"
    )
    evidence.write_json(
        "broker_subsz.json",
        {
            "prompts": n_prompts,
            "mux_prefix": mux_prefix,
            "mux_subs_count": len(mux_subs),
            "mux_subs": mux_subs,
            "broker_total_subscriptions": subsz.get("num_subscriptions"),
        },
    )

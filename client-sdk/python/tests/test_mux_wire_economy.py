"""Wire-economy regression: one SUB per :class:`Agents`, not one per prompt.

The interim mux inbox (`src/synadia_ai/agents/_mux.py`) exists to cut
SUB+flush traffic from one-per-prompt to one-per-:class:`Agents`. That's
the load-bearing observable consequence of PR #66 / TS PR-66-Python-
catch-up — assert it directly so a regression to the per-prompt
``subscribe + publish`` pattern shows up as a test failure rather than
a silent perf regression.

We can't observe SUB frames from a NATS client (nats-py doesn't surface
them), so we instead instrument the connection's own ``subscribe()``
method and count calls during a 5-prompt sequence. The expected count
is 1 (the mux SUB), not 5.
"""

from __future__ import annotations

import asyncio
import json
from types import MappingProxyType
from typing import TYPE_CHECKING

from synadia_ai.agents import (
    Agent,
    AgentInfo,
    Agents,
    EndpointInfo,
    ResponseChunk,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.harness.evidence import EvidenceRecorder

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

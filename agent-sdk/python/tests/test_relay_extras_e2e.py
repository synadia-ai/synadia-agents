"""§5.6: a handler that relays the envelope it received preserves its unknown fields.

Two real :class:`AgentService` hosts on one NATS server: the outer one's
handler forwards the envelope it was handed to the inner one through an
:class:`Agents` client, as a relaying agent does. The inner handler gets
the top-level fields the original caller sent that the protocol does not
define, verbatim, a ``null`` among them.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from synadia_ai.agents import Agent, Agents, DiscoverFilter, Envelope, ResponseChunk

from synadia_ai.agent_service import AgentService, PromptStream

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder

AGENT = "relay"
OWNER = "pytest"


def _host(nc: NATSClient, session_name: str) -> AgentService:
    return AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name=session_name,
        nc=nc,
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
    )


async def _find(agents: Agents, session_name: str) -> Agent:
    found = await agents.discover(filter=DiscoverFilter(agent=AGENT, session_name=session_name))
    assert len(found) == 1, found
    return found[0]


async def test_a_relayed_envelope_keeps_the_fields_the_protocol_does_not_define(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    agents = Agents(nc=nc)
    inner, outer = _host(nc, "inner"), _host(nc, "outer")
    received: list[Envelope] = []

    async def at_inner(envelope: Envelope, stream: PromptStream) -> None:
        received.append(envelope)
        await stream.send("inner ok")

    inner.on_prompt(at_inner)
    try:
        await inner.start()
        target = await _find(agents, "inner")

        async def at_outer(envelope: Envelope, stream: PromptStream) -> None:
            async for msg in target.prompt(envelope):
                if isinstance(msg, ResponseChunk):
                    await stream.send(msg.text)

        outer.on_prompt(at_outer)
        await outer.start()
        relay = await _find(agents, "outer")

        sent = Envelope(prompt="hi", x_ext={"id": "7", "gone": None}, nil=None)
        texts = [m.text async for m in relay.prompt(sent) if isinstance(m, ResponseChunk)]
    finally:
        await agents.close()
        await outer.stop()
        await inner.stop()

    evidence.write_json("inner-received.json", [e.model_dump(mode="json") for e in received])
    assert texts == ["inner ok"]
    assert len(received) == 1
    assert received[0].prompt == "hi"
    assert received[0].extras == {"x_ext": {"id": "7", "gone": None}, "nil": None}

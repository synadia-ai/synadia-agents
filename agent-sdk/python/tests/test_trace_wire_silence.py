"""With tracing off, the extension must leave no trace on the wire.

Not "no edge records" — nothing at all: the prompt envelope must be
byte-identical to plain protocol 0.3, no subject outside the normal set
may be touched, and no message may carry the JetStream de-duplication
header the edge publisher uses. This is the guard that fails the moment
someone adds an unconditional publish.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

import nats
from synadia_ai.agents import Agents

from synadia_ai.agent_service import AgentService

if TYPE_CHECKING:
    from nats.aio.msg import Msg

    from tests.harness.nats_server import RunningServer

AGENT = "silent"


async def _run_untraced_lifecycle(url: str) -> list[Msg]:
    """Discovery, a prompt, a status probe and shutdown — nothing traced."""
    nc = await nats.connect(url)
    seen: list[Msg] = []

    async def spy(msg: Msg) -> None:
        seen.append(msg)

    await nc.subscribe(">", cb=spy)
    await nc.flush()

    svc = AgentService(
        nc=nc,
        agent=AGENT,
        owner="p",
        session_name="s",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
    )

    async def handler(env: Any, stream: Any) -> None:
        await stream.send("ok")

    svc.on_prompt(handler)
    await svc.start()

    client = Agents(nc=nc)
    handle = next(a for a in await client.discover() if a.agent == AGENT)
    async for _ in handle.prompt("hello"):
        pass
    await handle.status()

    await asyncio.sleep(0.2)
    await svc.stop()
    await client.close()
    await nc.close()
    return seen


async def test_no_message_reaches_a_trace_subject(nats_server: RunningServer) -> None:
    seen = await _run_untraced_lifecycle(nats_server.url)
    stray = [m.subject for m in seen if m.subject.startswith("TRACE")]
    assert stray == [], f"untraced run published to trace subjects: {stray}"


async def test_no_message_carries_a_dedup_header(nats_server: RunningServer) -> None:
    seen = await _run_untraced_lifecycle(nats_server.url)
    stray = [m.subject for m in seen if "Nats-Msg-Id" in (m.headers or {})]
    assert stray == [], f"untraced run stamped Nats-Msg-Id on: {stray}"


async def test_the_prompt_envelope_is_plain_v0_3(nats_server: RunningServer) -> None:
    seen = await _run_untraced_lifecycle(nats_server.url)
    prompts = [m for m in seen if m.subject.startswith(f"agents.prompt.{AGENT}.")]
    assert len(prompts) == 1
    assert prompts[0].data == b'{"prompt":"hello"}', prompts[0].data
    assert set(json.loads(prompts[0].data)) == {"prompt"}


async def test_only_the_expected_subjects_are_touched(nats_server: RunningServer) -> None:
    seen = await _run_untraced_lifecycle(nats_server.url)
    unexpected = sorted(
        {
            m.subject
            for m in seen
            if not (
                m.subject.startswith("_INBOX.")
                or m.subject.startswith("$SRV.")
                or m.subject.startswith("agents.")
            )
        }
    )
    assert unexpected == [], f"untraced run touched unexpected subjects: {unexpected}"

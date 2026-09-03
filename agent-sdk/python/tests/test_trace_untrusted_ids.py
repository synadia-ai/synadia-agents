"""A receiver adopts only well-formed lineage.

The ids a caller sends are stamped verbatim on the agent's model requests,
as header values, by :meth:`PromptStream.trace_headers`. They are
untrusted input, so an id that is not shaped like what the SDKs mint is a
malformed envelope: the §9 ``400`` frame and the terminator, no ack, and
the handler never runs — the same treatment as any other wrongly-shaped
field, and the same as the TypeScript host.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

import pytest

from synadia_ai.agent_service import AgentService

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

AGENT = "untrusted"


async def _replies(nc: NATSClient, subject: str, payload: bytes) -> list[Msg]:
    inbox = nc.new_inbox()
    sub = await nc.subscribe(inbox)
    try:
        await nc.publish(subject, payload, reply=inbox)
        collected: list[Msg] = []
        while True:
            msg = await asyncio.wait_for(sub.next_msg(), timeout=5.0)
            collected.append(msg)
            if msg.data == b"" and not msg.headers:
                return collected
    finally:
        await sub.unsubscribe()


@pytest.mark.parametrize(
    "thread_id",
    [
        "a" * 30 + "\r\nX-Injected: yes",
        "A" * 32,
        "a" * 31,
        "a" * (1 << 16),
    ],
    ids=["header-injection", "uppercase", "short", "huge"],
)
async def test_a_malformed_thread_id_is_a_400_and_never_reaches_the_handler(
    nc: NATSClient, thread_id: str
) -> None:
    ran: list[Any] = []

    svc = AgentService(
        nc=nc,
        agent=AGENT,
        owner="p",
        session_name="s",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
    )

    async def handler(env: Any, stream: Any) -> None:
        ran.append(stream.trace_headers())
        await stream.send("ok")

    svc.on_prompt(handler)
    await svc.start()
    try:
        payload = json.dumps({"prompt": "hi", "thread_id": thread_id}).encode()
        frames = await _replies(nc, svc.subject.inbox, payload)
    finally:
        await svc.stop()

    assert ran == [], f"handler ran with untrusted lineage: {ran}"
    assert len(frames) == 2, [(dict(m.headers or {}), m.data[:60]) for m in frames]
    error, terminator = frames
    assert (error.headers or {}).get("Nats-Service-Error-Code") == "400"
    assert terminator.data == b"" and not terminator.headers

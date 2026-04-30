"""Wire-level tests for the heartbeat publisher (§8 publisher half).

Exercises ``run_publisher``, ``publish_one``, and the
``build_heartbeat_payload`` helper end-to-end against a real NATS
server:

- ``publish_one`` emits exactly one §8.3-shaped frame on
  ``agents.hb.{a}.{o}.{n}``.
- ``run_publisher`` emits one frame immediately (subscribe-before-
  discover, §8.5) and continues at the configured interval until the
  ``stop`` event fires.
- ``build_heartbeat_payload`` populates every required §8.3 field —
  shared with the status-endpoint handler so heartbeat and status
  responses agree byte-for-byte.

Wire evidence lands in ``tests/_evidence/<nodeid>/messages.jsonl`` so
the chunk-by-chunk publishing cadence is reviewable by eye.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from synadia_ai.agents import AgentSubject, HeartbeatPayload

from synadia_ai.agent_service.heartbeat import (
    build_heartbeat_payload,
    publish_one,
    run_publisher,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


AGENT = "test"
OWNER = "pytest"
SESSION_NAME = "publisher"
INSTANCE_ID = "publisher-instance-A"


def test_build_heartbeat_payload_populates_required_fields() -> None:
    """§8.3: agent, owner, instance_id, ts, interval_s — no session field."""
    subject = AgentSubject.new(agent=AGENT, owner=OWNER, session_name=SESSION_NAME)
    payload = build_heartbeat_payload(subject, interval_s=7, instance_id=INSTANCE_ID)

    assert payload.agent == AGENT
    assert payload.owner == OWNER
    assert payload.instance_id == INSTANCE_ID
    assert payload.interval_s == 7
    # `ts` is UTC ISO 8601 with seconds precision and a Z suffix.
    assert payload.ts.endswith("Z")

    encoded = json.loads(payload.model_dump_json())
    assert "session" not in encoded, (
        "v0.3 §8.3 payload MUST NOT carry a session key — the publishing subject IS the session."
    )


async def test_publish_one_emits_single_frame_on_heartbeat_subject(
    nc: NATSClient,
) -> None:
    """One ``publish_one`` call → exactly one §8.3 frame on the heartbeat subject."""
    subject = AgentSubject.new(agent=AGENT, owner=OWNER, session_name="publisher-one")
    sub = await nc.subscribe(subject.heartbeat)
    try:
        await publish_one(nc, subject, interval_s=5, instance_id=INSTANCE_ID)
        msg = await sub.next_msg(timeout=1.0)
        assert msg.subject == subject.heartbeat
        payload = HeartbeatPayload.model_validate_json(msg.data)
        assert payload.agent == AGENT
        assert payload.owner == OWNER
        assert payload.instance_id == INSTANCE_ID
        assert payload.interval_s == 5
        # No second frame should arrive — `publish_one` is one-shot.
        try:
            await sub.next_msg(timeout=0.2)
        except TimeoutError:
            return
        else:
            raise AssertionError("publish_one emitted more than one frame")
    finally:
        await sub.unsubscribe()


async def test_run_publisher_emits_immediate_then_periodic(nc: NATSClient) -> None:
    """``run_publisher`` emits one frame immediately and one per interval thereafter.

    The §8.5 subscribe-before-discover invariant requires the first
    heartbeat to land *without* waiting a full interval, so a caller
    that subscribes-then-discovers sees liveness right away. We sample
    the first three frames and check inter-arrival times relative to
    the configured 0.3 s interval.
    """
    subject = AgentSubject.new(agent=AGENT, owner=OWNER, session_name="publisher-loop")
    sub = await nc.subscribe(subject.heartbeat)
    stop = asyncio.Event()
    interval_s = 1
    task = asyncio.create_task(
        run_publisher(nc, subject, interval_s=interval_s, instance_id=INSTANCE_ID, stop=stop),
        name="hb-test-publisher",
    )
    try:
        loop = asyncio.get_running_loop()

        # Frame 1 — emitted immediately on entry; should arrive well under
        # one full interval.
        t0 = loop.time()
        msg1 = await sub.next_msg(timeout=0.5)
        elapsed1 = loop.time() - t0
        assert elapsed1 < 0.5, (
            f"first heartbeat should arrive ~immediately (§8.5); waited {elapsed1:.3f}s"
        )

        # Frames 2 & 3 — should arrive at ~interval cadence.
        t1 = loop.time()
        msg2 = await sub.next_msg(timeout=interval_s + 0.5)
        gap2 = loop.time() - t1
        assert interval_s - 0.3 <= gap2 <= interval_s + 0.5, (
            f"second heartbeat gap {gap2:.3f}s outside [interval-0.3s, interval+0.5s]"
        )

        t2 = loop.time()
        msg3 = await sub.next_msg(timeout=interval_s + 0.5)
        gap3 = loop.time() - t2
        assert interval_s - 0.3 <= gap3 <= interval_s + 0.5, (
            f"third heartbeat gap {gap3:.3f}s outside [interval-0.3s, interval+0.5s]"
        )

        for msg in (msg1, msg2, msg3):
            payload = HeartbeatPayload.model_validate_json(msg.data)
            assert payload.instance_id == INSTANCE_ID
            assert payload.interval_s == interval_s
    finally:
        stop.set()
        await task
        await sub.unsubscribe()


async def test_run_publisher_stops_promptly_on_event(nc: NATSClient) -> None:
    """Setting ``stop`` cancels the next sleep — publisher returns within ~one tick."""
    subject = AgentSubject.new(agent=AGENT, owner=OWNER, session_name="publisher-stop")
    stop = asyncio.Event()
    task = asyncio.create_task(
        run_publisher(nc, subject, interval_s=10, instance_id=INSTANCE_ID, stop=stop),
        name="hb-test-stop",
    )

    # Let the immediate first publish go through, then signal stop.
    await asyncio.sleep(0.1)
    stop.set()

    loop = asyncio.get_running_loop()
    t0 = loop.time()
    await task
    elapsed = loop.time() - t0
    assert elapsed < 1.0, f"publisher should exit promptly after stop is set; took {elapsed:.3f}s"

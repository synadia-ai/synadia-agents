"""Unit tests for the heartbeat payload and tracker (§8).

Round-trips the canonical example from spec appendix B.11 and exercises the
forward-compat requirement that unknown fields are tolerated. Also covers
:class:`HeartbeatTracker` re-keying on ``payload.instance_id`` and the
per-instance ``on_heartbeat`` listener API.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from natsagent.heartbeat import (
    DEFAULT_LIVENESS_SLACK,
    HeartbeatPayload,
    HeartbeatTracker,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


def test_decodes_spec_example() -> None:
    """Appendix B.11 — exact wire shape with session + instance_id."""
    wire = (
        b'{"agent":"claude-code","owner":"aconnolly","session":"synadia-com-2",'
        b'"instance_id":"VMKS6MHK71PCPWGY38A7N5",'
        b'"ts":"2026-04-21T14:23:01Z","interval_s":30}'
    )
    hb = HeartbeatPayload.model_validate_json(wire)
    assert hb.agent == "claude-code"
    assert hb.owner == "aconnolly"
    assert hb.session == "synadia-com-2"
    assert hb.instance_id == "VMKS6MHK71PCPWGY38A7N5"
    assert hb.ts == "2026-04-21T14:23:01Z"
    assert hb.interval_s == 30


def test_session_optional() -> None:
    """Session-less harnesses (openclaw) omit the field on the wire."""
    wire = (
        b'{"agent":"openclaw","owner":"rene","instance_id":"ABC",'
        b'"ts":"2026-04-21T00:00:00Z","interval_s":30}'
    )
    hb = HeartbeatPayload.model_validate_json(wire)
    assert hb.session is None


def test_unknown_fields_tolerated() -> None:
    """§8.3: receivers MUST tolerate additional unknown fields."""
    wire = (
        b'{"agent":"claude-code","owner":"alice","instance_id":"X",'
        b'"ts":"2026-04-21T00:00:00Z","interval_s":30,'
        b'"future_field":42,"another":"ok"}'
    )
    hb = HeartbeatPayload.model_validate_json(wire)
    assert hb.agent == "claude-code"


def test_encoded_form_omits_session_when_absent() -> None:
    """Session-less payloads MUST NOT emit an empty `session` key on the wire."""
    hb = HeartbeatPayload(
        agent="openclaw",
        owner="rene",
        instance_id="X",
        ts="2026-04-21T00:00:00Z",
        interval_s=30,
    )
    parsed = json.loads(hb.model_dump_json(exclude_none=True))
    assert "session" not in parsed
    assert parsed == {
        "agent": "openclaw",
        "owner": "rene",
        "instance_id": "X",
        "ts": "2026-04-21T00:00:00Z",
        "interval_s": 30,
    }


def test_encoded_form_includes_session_when_present() -> None:
    hb = HeartbeatPayload(
        agent="claude-code",
        owner="alice",
        session="proj-1",
        instance_id="X",
        ts="2026-04-21T00:00:00Z",
        interval_s=30,
    )
    parsed = json.loads(hb.model_dump_json(exclude_none=True))
    assert parsed["session"] == "proj-1"


# ---------------------------------------------------------------------------
# HeartbeatTracker — keyed on instance_id, per-instance listeners.
# ---------------------------------------------------------------------------


async def test_tracker_keys_on_instance_id_not_subject(nc: NATSClient) -> None:
    """Two instances of the same (agent, owner, name) on the same subject
    MUST stay distinguishable in tracker state — the key is
    ``payload.instance_id``, not the subject."""
    tracker = HeartbeatTracker(nc)
    await tracker.start()
    try:
        subject = "agents.test.pytest.shared.heartbeat"
        for instance_id in ("instance-A", "instance-B"):
            payload = HeartbeatPayload(
                agent="test",
                owner="pytest",
                instance_id=instance_id,
                ts="2026-04-21T00:00:00Z",
                interval_s=5,
            )
            await nc.publish(subject, payload.model_dump_json(exclude_none=True).encode())

        # Wait for both heartbeats to land in the tracker. We poll rather
        # than sleep so the test is fast and deterministic.
        deadline = asyncio.get_event_loop().time() + 2.0
        while asyncio.get_event_loop().time() < deadline:
            if (
                tracker.liveness("instance-A") is not None
                and tracker.liveness("instance-B") is not None
            ):
                break
            await asyncio.sleep(0.05)

        a = tracker.liveness("instance-A")
        b = tracker.liveness("instance-B")
        assert a is not None and a.instance_id == "instance-A" and a.is_online
        assert b is not None and b.instance_id == "instance-B" and b.is_online
    finally:
        await tracker.stop()


async def test_tracker_liveness_returns_none_for_unknown(nc: NATSClient) -> None:
    tracker = HeartbeatTracker(nc)
    await tracker.start()
    try:
        assert tracker.liveness("never-seen") is None
    finally:
        await tracker.stop()


async def test_tracker_liveness_is_offline_when_stale(nc: NATSClient) -> None:
    """`is_online` is False once the elapsed time exceeds slack * interval_s."""
    tracker = HeartbeatTracker(nc)
    await tracker.start()
    try:
        subject = "agents.test.pytest.stale.heartbeat"
        payload = HeartbeatPayload(
            agent="test",
            owner="pytest",
            instance_id="stale-id",
            ts="2026-04-21T00:00:00Z",
            interval_s=5,
        )
        await nc.publish(subject, payload.model_dump_json(exclude_none=True).encode())

        deadline = asyncio.get_event_loop().time() + 2.0
        while asyncio.get_event_loop().time() < deadline:
            if tracker.liveness("stale-id") is not None:
                break
            await asyncio.sleep(0.05)

        # Probe with `now` advanced past the slack window — the snapshot
        # should report offline. The default slack is 3, interval is 5,
        # so anything > 15s in the future is offline.
        liveness_fresh = tracker.liveness("stale-id")
        assert liveness_fresh is not None and liveness_fresh.is_online

        future = datetime.now(UTC) + timedelta(seconds=DEFAULT_LIVENESS_SLACK * 5 + 1)
        liveness_stale = tracker.liveness("stale-id", now=future)
        assert liveness_stale is not None
        assert liveness_stale.is_online is False
    finally:
        await tracker.stop()


async def test_tracker_on_heartbeat_listener_fires_and_unsubscribes(
    nc: NATSClient,
) -> None:
    """Per-instance listener fires for matching beats and stops on unsubscribe."""
    tracker = HeartbeatTracker(nc)
    await tracker.start()
    seen: list[HeartbeatPayload] = []
    unsubscribe = tracker.on_heartbeat("listener-id", seen.append)
    try:
        subject = "agents.test.pytest.listener.heartbeat"
        for _ in range(2):
            payload = HeartbeatPayload(
                agent="test",
                owner="pytest",
                instance_id="listener-id",
                ts="2026-04-21T00:00:00Z",
                interval_s=5,
            )
            await nc.publish(subject, payload.model_dump_json(exclude_none=True).encode())

        deadline = asyncio.get_event_loop().time() + 2.0
        while asyncio.get_event_loop().time() < deadline:
            if len(seen) >= 2:
                break
            await asyncio.sleep(0.05)
        assert len(seen) == 2

        # Unsubscribe — further beats must NOT reach the listener.
        unsubscribe()
        await nc.publish(
            subject,
            HeartbeatPayload(
                agent="test",
                owner="pytest",
                instance_id="listener-id",
                ts="2026-04-21T00:00:00Z",
                interval_s=5,
            )
            .model_dump_json(exclude_none=True)
            .encode(),
        )
        # Give the broker a moment to deliver — then assert NO new entry.
        await asyncio.sleep(0.1)
        assert len(seen) == 2

        # And listener for a different instance must not fire either.
        other: list[HeartbeatPayload] = []
        unsubscribe_other = tracker.on_heartbeat("other-id", other.append)
        try:
            await nc.publish(
                subject,
                HeartbeatPayload(
                    agent="test",
                    owner="pytest",
                    instance_id="listener-id",
                    ts="2026-04-21T00:00:00Z",
                    interval_s=5,
                )
                .model_dump_json(exclude_none=True)
                .encode(),
            )
            await asyncio.sleep(0.1)
            assert other == []
        finally:
            unsubscribe_other()
    finally:
        await tracker.stop()

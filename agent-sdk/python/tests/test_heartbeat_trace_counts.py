"""A traced service reports its trace record counts on the heartbeat.

A service that opted in to tracing puts how many trace records its
process has published and dropped since it started on every heartbeat
and on the status reply, as ``records_published`` and
``records_dropped`` — so whoever consumes the heartbeat knows how many
records the process failed to publish. An untraced service reports
neither: its heartbeat stays byte-identical to plain protocol 0.3. The
TypeScript service does the same.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import pytest
from synadia_ai.agents import (
    AgentSubject,
    HeartbeatPayload,
    TraceOptions,
    count_trace_record_dropped,
    count_trace_record_published,
    trace_record_counts,
)

from synadia_ai.agent_service import AgentService
from synadia_ai.agent_service.heartbeat import build_heartbeat_payload, run_publisher

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder


async def _first_heartbeat_and_status(
    nc: NATSClient,
    agent: str,
    *,
    trace: TraceOptions | None,
    between_beat_and_status: Callable[[], None] = lambda: None,
) -> tuple[HeartbeatPayload, HeartbeatPayload]:
    svc = AgentService(
        nc=nc,
        agent=agent,
        owner="p",
        session_name="s",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        trace=trace,
    )

    async def handler(_env: Any, stream: Any) -> None:
        await stream.send("ok")

    svc.on_prompt(handler)
    sub = await nc.subscribe(svc.subject.heartbeat)
    await nc.flush()
    await svc.start()
    try:
        first = await sub.next_msg(timeout=2.0)
        heartbeat = HeartbeatPayload.model_validate_json(first.data)
        between_beat_and_status()
        reply = await nc.request(svc.subject.status, b"", timeout=2.0)
        status = HeartbeatPayload.model_validate_json(reply.data)
        return heartbeat, status
    finally:
        await sub.unsubscribe()
        await svc.stop()


async def test_traced_service_reports_the_process_wide_counts(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    # The counters are process-wide and cumulative; move both so the
    # heartbeat provably reads them rather than a constant.
    count_trace_record_published()
    count_trace_record_dropped()
    expected = trace_record_counts()
    heartbeat, status = await _first_heartbeat_and_status(nc, "hb-traced", trace=TraceOptions())
    evidence.write_json("heartbeat.json", json.loads(heartbeat.model_dump_json()))
    evidence.write_json("status.json", json.loads(status.model_dump_json()))
    for payload in (heartbeat, status):
        assert payload.extras["records_published"] == expected.published
        assert payload.extras["records_dropped"] == expected.dropped


async def test_counts_are_read_fresh_on_every_beat(nc: NATSClient) -> None:
    """One service: a drop counted after its first heartbeat shows on the
    status reply that follows."""
    heartbeat, status = await _first_heartbeat_and_status(
        nc, "hb-fresh", trace=TraceOptions(), between_beat_and_status=count_trace_record_dropped
    )
    dropped_before = heartbeat.extras["records_dropped"]
    assert isinstance(dropped_before, int)
    assert status.extras["records_dropped"] == dropped_before + 1


async def test_propagate_only_service_reports_neither_count(nc: NATSClient) -> None:
    """Propagate-only publishes no records; a constant 0/0 would look like a healthy zero."""
    heartbeat, status = await _first_heartbeat_and_status(
        nc, "hb-propagate", trace=TraceOptions(edge_subject=None)
    )
    for payload in (heartbeat, status):
        assert payload.extras == {}


async def test_untraced_service_reports_neither_count(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    heartbeat, status = await _first_heartbeat_and_status(nc, "hb-untraced", trace=None)
    evidence.write_json("heartbeat.json", json.loads(heartbeat.model_dump_json()))
    for payload in (heartbeat, status):
        assert payload.extras == {}
        assert set(json.loads(payload.model_dump_json())) == {
            "agent",
            "owner",
            "session",
            "instance_id",
            "ts",
            "interval_s",
        }


def test_build_heartbeat_payload_merges_extras_alongside_the_required_fields() -> None:
    """The Python encoder's ``extras`` slot, mirroring the TypeScript one."""
    subject = AgentSubject.new(agent="test", owner="pytest", session_name="extras")
    payload = build_heartbeat_payload(
        subject, 7, "X", {"records_published": 3, "records_dropped": 1}
    )
    encoded = json.loads(payload.model_dump_json())
    assert encoded["records_published"] == 3
    assert encoded["records_dropped"] == 1
    assert encoded["agent"] == "test"
    assert payload.extras == {"records_published": 3, "records_dropped": 1}
    # Absent extras leave the payload exactly as before.
    plain = json.loads(build_heartbeat_payload(subject, 7, "X").model_dump_json())
    assert set(plain) == {"agent", "owner", "session", "instance_id", "ts", "interval_s"}


def test_build_heartbeat_payload_refuses_an_extra_under_a_required_field_name() -> None:
    subject = AgentSubject.new(agent="test", owner="pytest", session_name="extras")
    with pytest.raises(ValueError, match=r"\['ts'\]"):
        build_heartbeat_payload(subject, 7, "X", {"ts": "not yours"})


async def test_bad_extras_cost_the_beat_its_extras_and_nothing_more(nc: NATSClient) -> None:
    """A provider that raises, then one whose value cannot be serialised: the
    heartbeat keeps going, without extras, and the publisher survives."""
    subject = AgentSubject.new(agent="test", owner="pytest", session_name="bad-extras")
    calls = 0

    def provider() -> dict[str, object]:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("counter backend unavailable")
        return {"opaque": object()}  # constructs, but does not serialise

    sub = await nc.subscribe(subject.heartbeat)
    stop = asyncio.Event()
    task = asyncio.create_task(run_publisher(nc, subject, 1, "I", stop, extras=provider))
    try:
        first = HeartbeatPayload.model_validate_json((await sub.next_msg(timeout=1.0)).data)
        second = HeartbeatPayload.model_validate_json((await sub.next_msg(timeout=2.0)).data)
        assert first.extras == {} and second.extras == {}
        assert calls == 2
        assert not task.done(), "a bad extra must not stop the heartbeat publisher"
    finally:
        stop.set()
        await task
        await sub.unsubscribe()

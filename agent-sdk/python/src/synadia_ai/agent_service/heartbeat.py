"""Heartbeat publisher half — agent-side per protocol §8.

Periodically emits a §8.3 :class:`~synadia_ai.agents.HeartbeatPayload`
on the agent's heartbeat subject. The wire shape, the
``HeartbeatTracker`` (caller-side), and the ``now_iso`` helper live in
:mod:`synadia_ai.agents`; this module owns only the *publishing*
side and the ``build_heartbeat_payload`` helper that the
:class:`~synadia_ai.agent_service.AgentService` status handler reuses
to ensure heartbeat and status responses share the exact same payload
construction path.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import TYPE_CHECKING

from synadia_ai.agents import HeartbeatPayload
from synadia_ai.agents.heartbeat import now_iso

from ._logging import get_logger

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from synadia_ai.agents import AgentSubject

log = get_logger(__name__)


def build_heartbeat_payload(
    subject: AgentSubject,
    interval_s: int,
    instance_id: str,
) -> HeartbeatPayload:
    """Construct a §8.3 heartbeat payload for ``subject``.

    Pure helper shared between the heartbeat publisher and the v0.3
    ``status`` request/response endpoint — both emit the same payload
    shape, and richer agent metadata added in future PRs lands here in
    one place.
    """
    return HeartbeatPayload(
        agent=subject.agent,
        owner=subject.owner,
        session=subject.session_name,
        instance_id=instance_id,
        ts=now_iso(),
        interval_s=interval_s,
    )


async def publish_one(
    nc: NATSClient,
    subject: AgentSubject,
    interval_s: int,
    instance_id: str,
) -> None:
    """Publish a single heartbeat frame to the agent's heartbeat subject."""
    payload = build_heartbeat_payload(subject, interval_s, instance_id)
    data = payload.model_dump_json().encode("utf-8")
    await nc.publish(subject.heartbeat, data)


async def run_publisher(
    nc: NATSClient,
    subject: AgentSubject,
    interval_s: int,
    instance_id: str,
    stop: asyncio.Event,
) -> None:
    """Periodically publish heartbeats until `stop` is set.

    A failed publish (e.g. ``ConnectionClosedError`` after a broker
    restart) MUST NOT crash the publisher task with a non-cancellation
    exception: that would (a) make the agent go dark while the micro
    service still appears registered, and (b) cause :meth:`AgentService.stop`
    to re-raise on teardown. The publisher logs the failure and exits
    cleanly so ``stop()`` can complete; the surrounding service decides
    whether to recover.
    """
    log.debug("heartbeat publisher starting for %s (interval=%ss)", subject.inbox, interval_s)
    try:
        # Emit one heartbeat immediately so callers that subscribe-then-discover
        # observe liveness without waiting a full interval (§8.5).
        await publish_one(nc, subject, interval_s, instance_id)
        while not stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=interval_s)
            if stop.is_set():
                break
            await publish_one(nc, subject, interval_s, instance_id)
    except Exception:
        log.exception("heartbeat publisher failed for %s; exiting", subject.inbox)
        return
    log.debug("heartbeat publisher stopped for %s", subject.inbox)


__all__ = [
    "build_heartbeat_payload",
    "publish_one",
    "run_publisher",
]

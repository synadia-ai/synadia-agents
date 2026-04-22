"""Heartbeat per protocol §8: payload schema + publisher loop + subscriber tracker."""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict

from ._logging import get_logger

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from .subjects import AgentSubject

log = get_logger(__name__)


class HeartbeatPayload(BaseModel):
    """Heartbeat wire payload per §8.3.

    The instance name is deliberately absent: §8.3 directs receivers to
    extract it from the 4th token of the heartbeat subject. ``extra="ignore"``
    because §8.3 requires callers to tolerate unknown fields for forward
    compat; pydantic will silently drop them during decode.
    """

    model_config = ConfigDict(extra="ignore", frozen=True)

    agent: str
    owner: str
    session: str | None = None
    instance_id: str
    ts: str  # UTC ISO 8601
    interval_s: int


def now_iso() -> str:
    """UTC ISO 8601 with seconds precision and `Z` suffix."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


async def publish_one(
    nc: NATSClient,
    subject: AgentSubject,
    interval_s: int,
    instance_id: str,
    session: str | None = None,
) -> None:
    """Publish a single heartbeat frame to the agent's heartbeat subject."""
    payload = HeartbeatPayload(
        agent=subject.agent,
        owner=subject.owner,
        session=session,
        instance_id=instance_id,
        ts=now_iso(),
        interval_s=interval_s,
    )
    # exclude_none keeps `session` off the wire when session-less (§8.3).
    data = payload.model_dump_json(exclude_none=True).encode("utf-8")
    await nc.publish(subject.heartbeat, data)


async def run_publisher(
    nc: NATSClient,
    subject: AgentSubject,
    interval_s: int,
    instance_id: str,
    stop: asyncio.Event,
    session: str | None = None,
) -> None:
    """Periodically publish heartbeats until `stop` is set."""
    log.debug("heartbeat publisher starting for %s (interval=%ss)", subject.inbox, interval_s)
    # Emit one heartbeat immediately so callers that subscribe-then-discover
    # observe liveness without waiting a full interval (§8.5).
    await publish_one(nc, subject, interval_s, instance_id, session)
    while not stop.is_set():
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval_s)
        if stop.is_set():
            break
        await publish_one(nc, subject, interval_s, instance_id, session)
    log.debug("heartbeat publisher stopped for %s", subject.inbox)


@dataclass(slots=True)
class AgentStatus:
    """Client-side view of an agent's liveness (§5.2, §5.3)."""

    subject: str
    last_seen: datetime | None = None
    interval_s: int | None = None

    def is_online(self, *, as_of: datetime | None = None, slack: int = 3) -> bool:
        """True if the last heartbeat is within `slack * interval_s` seconds of now."""
        if self.last_seen is None or self.interval_s is None:
            return False
        now = as_of if as_of is not None else datetime.now(UTC)
        elapsed = (now - self.last_seen).total_seconds()
        return elapsed <= slack * self.interval_s


class HeartbeatTracker:
    """Subscribes to the heartbeat wildcard and tracks per-agent last-seen state."""

    def __init__(self, nc: NATSClient) -> None:
        self._nc = nc
        self._statuses: dict[str, AgentStatus] = {}
        # nats Subscription — typed as object to keep this module free of runtime nats-py imports.
        self._sub: object | None = None

    async def start(self) -> None:
        """Subscribe to `agents.*.*.*.heartbeat` per §5.5 before any discovery happens."""
        self._sub = await self._nc.subscribe("agents.*.*.*.heartbeat", cb=self._on_heartbeat)
        log.debug("heartbeat tracker subscribed to agents.*.*.*.heartbeat")

    async def stop(self) -> None:
        if self._sub is not None:
            await self._sub.unsubscribe()  # type: ignore[attr-defined]
            self._sub = None

    def status(self, inbox: str) -> AgentStatus:
        """Return the tracked status for an agent inbox, creating an empty record if unseen."""
        return self._statuses.get(inbox, AgentStatus(subject=inbox))

    async def _on_heartbeat(self, msg: object) -> None:
        subject: str = msg.subject  # type: ignore[attr-defined]
        data: bytes = msg.data  # type: ignore[attr-defined]
        try:
            payload = HeartbeatPayload.model_validate_json(data)
        except Exception as exc:
            log.warning("ignoring malformed heartbeat on %s: %s", subject, exc)
            return
        inbox = subject.removesuffix(".heartbeat")
        self._statuses[inbox] = AgentStatus(
            subject=inbox,
            last_seen=datetime.now(UTC),
            interval_s=payload.interval_s,
        )

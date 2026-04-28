"""Heartbeat per protocol §8: payload schema + publisher loop + subscriber tracker.

Tracker storage is keyed on ``payload.instance_id`` (§8.3) — NOT on the
heartbeat subject — so multiple instances of the same logical agent
(spec §3.3) stay distinguishable. Mirrors the TS SDK's
``heartbeat/tracker.ts`` (PR #7).
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict

from ._logging import get_logger

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from .subjects import AgentSubject

log = get_logger(__name__)


# §8.1 (v0.3): heartbeat wildcard subject (verb is the abbreviation `hb`).
# Subscribed to by :class:`HeartbeatTracker`.
HEARTBEAT_SUBJECT = "agents.hb.*.*.*"

# §8.2 default: a tracked instance is online iff its last heartbeat is
# within ``slack * interval_s`` seconds of "now". Mirrors TS
# DEFAULT_LIVENESS_SLACK.
DEFAULT_LIVENESS_SLACK = 3


class HeartbeatPayload(BaseModel):
    """Heartbeat wire payload per §8.3.

    The payload no longer carries a session field — under v0.3 the
    publishing subject IS the session
    (``agents.hb.{agent}.{owner}.{session_name}``). Receivers that want
    the session name read it from the 5th subject token. The tracker
    keys on ``payload.instance_id`` per §8.3 so multiple instances of
    the same logical session stay distinguishable. ``extra="ignore"``
    because §8.3 requires callers to tolerate unknown fields for forward
    compat; pydantic will silently drop them during decode (a stray
    ``session`` from a non-compliant v0.2 peer is dropped here).
    """

    model_config = ConfigDict(extra="ignore", frozen=True)

    agent: str
    owner: str
    instance_id: str
    ts: str  # UTC ISO 8601
    interval_s: int


@dataclass(frozen=True, slots=True)
class Liveness:
    """Frozen snapshot of an instance's liveness (§8.2).

    Returned by :meth:`HeartbeatTracker.liveness` / :meth:`Agents.liveness`.
    ``is_online`` is precomputed at read time against
    ``DEFAULT_LIVENESS_SLACK * interval_s``; the snapshot does not update
    in place — callers should re-query the tracker for fresh state.
    """

    instance_id: str
    last_seen: datetime
    interval_s: int
    is_online: bool


HeartbeatListener = Callable[[HeartbeatPayload], None]


def now_iso() -> str:
    """UTC ISO 8601 with seconds precision and ``Z`` suffix."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    """Periodically publish heartbeats until `stop` is set."""
    log.debug("heartbeat publisher starting for %s (interval=%ss)", subject.inbox, interval_s)
    # Emit one heartbeat immediately so callers that subscribe-then-discover
    # observe liveness without waiting a full interval (§8.5).
    await publish_one(nc, subject, interval_s, instance_id)
    while not stop.is_set():
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval_s)
        if stop.is_set():
            break
        await publish_one(nc, subject, interval_s, instance_id)
    log.debug("heartbeat publisher stopped for %s", subject.inbox)


@dataclass(slots=True)
class _Entry:
    """Per-instance tracker state — mutable so updates are O(1)."""

    payload: HeartbeatPayload
    last_seen: datetime


class HeartbeatTracker:
    """Subscribes to the heartbeat wildcard and tracks per-instance state.

    Storage is keyed on ``payload.instance_id`` (§8.3) so multiple
    instances of the same logical agent stay distinguishable. Listener
    registration is per-instance: callers that want every beat fan out
    via the public :meth:`Agents.on_heartbeat`.
    """

    def __init__(self, nc: NATSClient) -> None:
        self._nc = nc
        self._entries: dict[str, _Entry] = {}
        self._listeners: dict[str, list[HeartbeatListener]] = {}
        # nats Subscription — typed as object to keep this module free of runtime nats-py imports.
        self._sub: object | None = None

    @property
    def is_started(self) -> bool:
        return self._sub is not None

    async def start(self) -> None:
        """Subscribe to the heartbeat wildcard (§8.5: subscribe-before-discover).

        Idempotent; calling more than once is a no-op. Flushes the
        connection so the SUB is registered at the server before this
        method returns.
        """
        if self._sub is not None:
            return
        self._sub = await self._nc.subscribe(HEARTBEAT_SUBJECT, cb=self._on_heartbeat)
        log.debug("heartbeat tracker subscribed to %s", HEARTBEAT_SUBJECT)
        # Best-effort flush so the SUB is visible at the server before
        # the caller starts publishing $SRV.PING / $SRV.INFO. nats-py
        # flush is async; we await it explicitly so subscribe-before-
        # discover (§8.5) is enforced rather than racy.
        with contextlib.suppress(Exception):
            await self._nc.flush()

    async def stop(self) -> None:
        if self._sub is not None:
            await self._sub.unsubscribe()  # type: ignore[attr-defined]
            self._sub = None

    def liveness(self, instance_id: str, *, now: datetime | None = None) -> Liveness | None:
        """Return a frozen snapshot of the tracked instance, or ``None`` if unseen.

        ``is_online`` is computed at call time against
        ``DEFAULT_LIVENESS_SLACK * interval_s``. The returned snapshot
        does not update in place; re-query for fresh state.
        """
        entry = self._entries.get(instance_id)
        if entry is None:
            return None
        as_of = now if now is not None else datetime.now(UTC)
        elapsed = (as_of - entry.last_seen).total_seconds()
        is_online = elapsed <= DEFAULT_LIVENESS_SLACK * entry.payload.interval_s
        return Liveness(
            instance_id=instance_id,
            last_seen=entry.last_seen,
            interval_s=entry.payload.interval_s,
            is_online=is_online,
        )

    def on_heartbeat(
        self,
        instance_id: str,
        listener: HeartbeatListener,
    ) -> Callable[[], None]:
        """Subscribe to heartbeats for a single instance.

        Returns an unsubscribe function — call it to drop the listener.
        Multiple listeners per instance are supported; each is invoked
        once per matching beat in registration order. Registering the
        same callable twice produces two independent registrations
        (mirrors the TS SDK's array semantics) — each unsubscribe call
        removes one occurrence and is idempotent thereafter.
        """
        bucket = self._listeners.setdefault(instance_id, [])
        bucket.append(listener)
        unsubscribed = False

        def _unsubscribe() -> None:
            nonlocal unsubscribed
            if unsubscribed:
                return
            unsubscribed = True
            existing = self._listeners.get(instance_id)
            if existing is None:
                return
            with contextlib.suppress(ValueError):
                existing.remove(listener)
            if not existing:
                self._listeners.pop(instance_id, None)

        return _unsubscribe

    async def _on_heartbeat(self, msg: object) -> None:
        subject: str = msg.subject  # type: ignore[attr-defined]
        data: bytes = msg.data  # type: ignore[attr-defined]
        try:
            payload = HeartbeatPayload.model_validate_json(data)
        except Exception as exc:
            log.warning("ignoring malformed heartbeat on %s: %s", subject, exc)
            return
        # §8.3: track by instance_id, NOT by subject — two instances of the
        # same (agent, owner, name) tuple share a heartbeat subject and must
        # remain distinguishable in tracker state.
        self._entries[payload.instance_id] = _Entry(
            payload=payload,
            last_seen=datetime.now(UTC),
        )
        listeners = self._listeners.get(payload.instance_id)
        if listeners:
            # Iterate over a snapshot — listeners may unsubscribe themselves.
            for listener in tuple(listeners):
                try:
                    listener(payload)
                except Exception:
                    log.exception("heartbeat listener raised for %s", payload.instance_id)


__all__ = [
    "DEFAULT_LIVENESS_SLACK",
    "HEARTBEAT_SUBJECT",
    "HeartbeatListener",
    "HeartbeatPayload",
    "HeartbeatTracker",
    "Liveness",
    "build_heartbeat_payload",
    "now_iso",
    "publish_one",
    "run_publisher",
]

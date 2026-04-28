""":class:`Agents` — caller-side entry point.

Owner of the heartbeat wildcard subscription and the entry point for
discovery. Construct with a pre-opened :class:`~nats.aio.client.Client`::

    import nats
    from synadia_ai.agents import Agents

    nc = await nats.connect(servers="nats://127.0.0.1:4222")
    agents = Agents(nc=nc)
    found = await agents.discover()
    [agent] = found
    async for msg in agent.prompt("hi"):
        ...
    await agents.close()    # SDK state only — does NOT close `nc`
    await nc.close()        # caller owns this

Mirrors the TS SDK's ``Agents`` class (PR #7) field-for-field. The
caller owns ``nc``; :meth:`Agents.close` tears down SDK-owned state
only (heartbeat wildcard sub, in-flight stream cancellation), and the
underlying :class:`~nats.aio.client.Client` is the caller's
responsibility.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import TYPE_CHECKING

from ._logging import get_logger
from .agent import DEFAULT_STREAM_INACTIVITY_TIMEOUT_S, Agent
from .discovery import (
    DEFAULT_DISCOVER_MAX_WAIT_S,
    DEFAULT_DISCOVER_STALL_S,
    DiscoverFilter,
    discover_agent_infos,
    matches_filter,
    ping_instance,
)
from .heartbeat import HeartbeatListener, HeartbeatTracker, Liveness

if TYPE_CHECKING:
    import logging

    from nats.aio.client import Client as NATSClient

log = get_logger(__name__)


class Agents:
    """Caller-side entry point. One per application; wraps a NATS connection.

    The caller retains ownership of ``nc`` — :meth:`close` does NOT close
    the underlying connection. Pass a custom logger via ``logger=`` to
    surface SDK-internal events through your app's logging stack;
    defaults to ``logging.getLogger("synadia_ai.agents.agents")``.
    """

    def __init__(
        self,
        *,
        nc: NATSClient,
        stream_inactivity_timeout: float = DEFAULT_STREAM_INACTIVITY_TIMEOUT_S,
        logger: logging.Logger | None = None,
    ) -> None:
        self._nc = nc
        self._stream_inactivity_timeout = stream_inactivity_timeout
        self._logger = logger if logger is not None else log
        self._tracker = HeartbeatTracker(nc)
        # Set when close() is called; passed to every Agent so in-flight
        # prompt streams can short-circuit instead of waiting on a torn-
        # down broker.
        self._close_event = asyncio.Event()
        self._closed = False
        self._lazy_start_task: asyncio.Task[None] | None = None

    @property
    def connection(self) -> NATSClient:
        """The underlying NATS connection (caller-owned)."""
        return self._nc

    @property
    def stream_inactivity_timeout(self) -> float:
        """Default per-stream inactivity timeout applied to every :meth:`Agent.prompt`."""
        return self._stream_inactivity_timeout

    @property
    def close_event(self) -> asyncio.Event:
        """Event that fires when :meth:`close` is called.

        Pass to :class:`Agent` constructors built outside of :meth:`discover`
        so in-flight streams on those handles abort when this :class:`Agents`
        is torn down — matching what :meth:`discover` does for handles it
        produces.
        """
        return self._close_event

    @property
    def is_closed(self) -> bool:
        """True if :meth:`close` has been called."""
        return self._closed

    async def discover(
        self,
        *,
        timeout: float | None = None,
        stall: float = DEFAULT_DISCOVER_STALL_S,
        max_wait: float = DEFAULT_DISCOVER_MAX_WAIT_S,
        filter: DiscoverFilter | None = None,
    ) -> list[Agent]:
        """Discover protocol-compliant agents reachable on the NATS connection.

        Returns a live ``list[Agent]`` — each entry is directly callable
        via :meth:`Agent.prompt`.

        Two strategies:

        - When ``timeout`` is ``None`` (default), the **stall** strategy
          is used: returns ``stall`` seconds after the most recent reply,
          or after ``max_wait`` seconds absolute, whichever fires first.
          Defaults: ``stall=0.2``, ``max_wait=2.0``. Snappy on lightly-
          loaded systems.
        - When ``timeout`` is set, the **timer** strategy is used: waits
          exactly ``timeout`` seconds and returns every responder seen
          in that window. Use for deterministic scans / health checks.

        ``filter`` AND-matches the discovered records by identity
        (``agent``, ``owner``, ``session_name``, ``protocol_version``)
        before the live :class:`Agent` instances are constructed.

        The first call to :meth:`discover` lazily starts the heartbeat
        wildcard subscription BEFORE publishing the discovery PING,
        enforcing §8.5 automatically.
        """
        self._ensure_open()
        if not self._tracker.is_started:
            await self._tracker.start()
        infos = await discover_agent_infos(
            self._nc,
            timeout_s=timeout,
            stall_s=stall,
            max_wait_s=max_wait,
        )
        return [
            Agent(
                self._nc,
                info,
                stream_inactivity_timeout=self._stream_inactivity_timeout,
                close_event=self._close_event,
            )
            for info in infos
            if matches_filter(info, filter)
        ]

    async def start_tracking(self) -> None:
        """Ensure the heartbeat wildcard subscription is established.

        Normally called implicitly by :meth:`discover` / :meth:`on_heartbeat`;
        use this when you want to start tracking before either.
        """
        self._ensure_open()
        await self._tracker.start()

    def liveness(self, instance_id: str) -> Liveness | None:
        """Return the passively-tracked liveness for an instance.

        ``None`` until at least one heartbeat has been observed for
        ``instance_id``. The :class:`Liveness` snapshot includes
        ``is_online`` precomputed at read time.
        """
        return self._tracker.liveness(instance_id)

    def on_heartbeat(
        self,
        instance_id: str,
        listener: HeartbeatListener,
    ) -> Callable[[], None]:
        """Subscribe to heartbeats for a single instance.

        Returns an unsubscribe function. The tracker is started lazily if
        needed — call :meth:`start_tracking` first (and await it) when
        you need to guarantee the subscription is live before a specific
        moment.
        """
        if not self._tracker.is_started and self._lazy_start_task is None:
            # Fire-and-forget: lazy start. Callers who need determinism
            # use start_tracking() first. Hold a reference so the task
            # isn't GC'd before it runs.
            self._lazy_start_task = asyncio.create_task(
                self._tracker.start(), name="heartbeat-tracker-lazy-start"
            )
        return self._tracker.on_heartbeat(instance_id, listener)

    async def ping(self, instance_id: str, *, timeout: float = 2.0) -> bool:
        """On-demand reachability check for a single instance (§8.4).

        Sends ``$SRV.PING.agents.{instance_id}`` and returns ``True`` as
        soon as any reply arrives within ``timeout`` seconds; ``False``
        on timeout or when the broker reports no responders.
        """
        self._ensure_open()
        return await ping_instance(self._nc, instance_id, timeout=timeout)

    async def close(self) -> None:
        """Tear down SDK-owned state. Idempotent.

        Cancels in-flight prompt streams via :attr:`close_event` and
        unsubscribes the heartbeat wildcard. The underlying NATS
        connection is NOT touched — the caller who opened it is
        responsible for closing it.
        """
        if self._closed:
            return
        self._closed = True
        self._close_event.set()
        await self._tracker.stop()

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("synadia_ai.agents.Agents is closed")


__all__ = ["Agents"]

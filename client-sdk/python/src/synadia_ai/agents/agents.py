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

Sender identity is off by default: no lookup and no header. Pass
``identity=Identity(signer=…, name=…)`` to sign every ``prompt`` /
``status`` request; an explicit identity without a signer sends an unsigned
claim when the connection has an NKEY identity. :meth:`Agents.self_id` is the connection's own agent
ID; :meth:`Agents.sign_sender` / :meth:`Agents.publish_signed` /
:meth:`Agents.request_signed` sign arbitrary publishes (JetStream
included); :meth:`Agents.resolve_sender` is the reverse lookup.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING

from ._logging import get_logger
from ._request import request_one
from .agent import DEFAULT_PROMPT_MAX_WAIT_S, DEFAULT_STREAM_INACTIVITY_TIMEOUT_S, Agent
from .discovery import (
    DEFAULT_DISCOVER_MAX_WAIT_S,
    DEFAULT_DISCOVER_STALL_S,
    AgentInfo,
    DiscoverFilter,
    discover_agent_infos,
    matches_filter,
    ping_instance,
)
from .errors import SenderSignatureRequiredError
from .heartbeat import HeartbeatListener, HeartbeatTracker, Liveness
from .identity.agent_id import AgentId
from .identity.options import (
    Identity,
    plan_sender_header,
    refresh_self_id_for,
    self_id_for,
)
from .identity.resolve_sender import DEFAULT_RESOLVE_TTL_S, SenderResolver
from .identity.sender_header import (
    AGENT_SENDER_HEADER,
    AgentSenderHeader,
    serialize_sender_header,
)
from .trace import TraceOptions

if TYPE_CHECKING:
    import logging

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

log = get_logger(__name__)

# Default `request_signed()` timeout — 2 seconds (mirrors the TS SDK's
# DEFAULT_REQUEST_SIGNED_TIMEOUT_MS).
DEFAULT_REQUEST_SIGNED_TIMEOUT_S: float = 2.0

#: JetStream de-duplication header; `publish_signed` sets it to the nonce.
NATS_MSG_ID_HEADER = "Nats-Msg-Id"


class Agents:
    """Caller-side entry point. One per application; wraps a NATS connection.

    The caller retains ownership of ``nc`` — :meth:`close` does NOT close
    the underlying connection. Pass a custom logger via ``logger=`` to
    surface SDK-internal events through your app's logging stack;
    defaults to ``logging.getLogger("synadia_ai.agents.agents")``.

    ``identity`` configures the sender-identity extension (signer,
    display name, unsigned-claim policy — see
    :class:`~synadia_ai.agents.identity.Identity`; its ``name`` is
    validated up front). ``resolve_ttl_s`` is the TTL of the
    ``$SRV.INFO`` index behind :meth:`resolve_sender` (default 10 s).
    """

    def __init__(
        self,
        *,
        nc: NATSClient,
        stream_inactivity_timeout: float = DEFAULT_STREAM_INACTIVITY_TIMEOUT_S,
        prompt_max_wait_s: float = DEFAULT_PROMPT_MAX_WAIT_S,
        logger: logging.Logger | None = None,
        identity: Identity | None = None,
        resolve_ttl_s: float = DEFAULT_RESOLVE_TTL_S,
        trace: TraceOptions | None = None,
    ) -> None:
        if prompt_max_wait_s <= 0:
            raise ValueError(f"prompt_max_wait_s must be > 0 (got {prompt_max_wait_s!r}).")
        self._nc = nc
        self._stream_inactivity_timeout = stream_inactivity_timeout
        self._prompt_max_wait_s = prompt_max_wait_s
        self._logger = logger if logger is not None else log
        self._identity = identity
        # Omission is meaningful: no trace options, no tracing.
        self._trace = trace
        self._resolver = SenderResolver(nc, ttl_s=resolve_ttl_s)
        self._tracker = HeartbeatTracker(nc)
        # Set when close() is called; passed to every Agent so in-flight
        # prompt streams can short-circuit instead of waiting on a torn-
        # down broker. The shared mux reply-inbox lives on the
        # connection itself (per-nc singleton in `_mux.py`); this Agents
        # does not own it, mirroring the TS SDK's `nc.requestMany`
        # design where the connection holds the mux.
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
    def prompt_max_wait_s(self) -> float:
        """Default absolute ceiling for :meth:`Agent.prompt` (overridable per-call)."""
        return self._prompt_max_wait_s

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

    @property
    def identity(self) -> Identity | None:
        """The sender-identity options this client was constructed with."""
        return self._identity

    @property
    def trace(self) -> TraceOptions | None:
        """The tracing options this client was constructed with; ``None`` = tracing off."""
        return self._trace

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
        enforcing §8.5 automatically. Discovery itself never starts sender-
        identity lookup; identity is resolved only by an explicitly enabled
        identity-bearing request.
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
                prompt_max_wait_s=self._prompt_max_wait_s,
                close_event=self._close_event,
                identity=self._identity,
                trace=self._trace,
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

    # --- sender identity -------------------------------------------------

    async def self_id(self) -> AgentId:
        """The connection's own agent ID (``{account}.{user}``).

        Obtained from ``$SYS.REQ.USER.INFO``. A configured signer is bound
        to that live user and account without using the signer-less memo.
        Raises :class:`NoIdentityError` (no NKEY
        user — the message names the fix),
        :class:`IdentityUnavailableError` (no answer / permission
        violation) or :class:`IdentityMismatchError` (a configured signer
        holds a different identity). Signer-less diagnostic lookups and
        failures are memoised; :meth:`refresh_self_id` retries at once.
        """
        self._ensure_open()
        return await self_id_for(self._identity, self._nc)

    async def refresh_self_id(self) -> AgentId:
        """Force a fresh identity lookup, discarding the memoised answer."""
        self._ensure_open()
        return await refresh_self_id_for(self._identity, self._nc)

    async def sign_sender(
        self, subject: str, payload: bytes | str, *, sub: str | None = None
    ) -> str:
        """Build a complete ``Agent-Sender`` header *value* for a publish to ``subject``.

        The SDK supplies the id, ``ts`` and a fresh nonce. Pass the exact
        subject and payload you will publish; set ``sub`` only behind a
        rename by your own account (sign the exporter's subject). Works
        for any publish, JetStream included
        (``headers={"Agent-Sender": value}``).

        Raises :class:`SenderSignatureRequiredError` when no signer is
        configured, else the :meth:`self_id` error when the identity is
        unavailable.
        """
        header = await self._signed_header(subject, _to_bytes(payload), sub)
        return serialize_sender_header(header)

    async def publish_signed(
        self,
        subject: str,
        payload: bytes | str,
        *,
        sub: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """Sign and publish in one step (core ``nc.publish``).

        Sets ``Nats-Msg-Id`` to the nonce so a JetStream stream's
        de-duplication window helps consumers. ``headers`` are merged in
        (``Agent-Sender`` / ``Nats-Msg-Id`` win). Same error rules as
        :meth:`sign_sender`.
        """
        data = _to_bytes(payload)
        hdrs = await self._signed_headers(subject, data, sub, headers)
        await self._nc.publish(subject, data, headers=hdrs)

    async def request_signed(
        self,
        subject: str,
        payload: bytes | str,
        *,
        sub: str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout_s: float = DEFAULT_REQUEST_SIGNED_TIMEOUT_S,
    ) -> Msg:
        """Sign and send a **single-reply** request on the SDK inbox.

        For services that answer once; prompt streams go through
        :meth:`Agent.prompt`. Same error rules as :meth:`sign_sender`,
        plus :class:`TimeoutError` / :class:`~nats.errors.NoRespondersError`
        from the transport.
        """
        data = _to_bytes(payload)
        hdrs = await self._signed_headers(subject, data, sub, headers)
        return await request_one(self._nc, subject, data, timeout_s=timeout_s, headers=hdrs)

    async def resolve_sender(self, id: AgentId | str) -> AgentInfo | None:
        """Reverse lookup: the verified agent registered under ``id``, or ``None``.

        Enumerates ``$SRV.INFO.agents`` (cached for ``resolve_ttl_s``),
        keeps only instances whose ``id_sig`` verifies over their own
        prompt subject, and returns the matching :class:`AgentInfo`. The
        lookup identifies; it never authorizes.
        """
        self._ensure_open()
        return await self._resolver.resolve(id)

    async def _signed_header(
        self, subject: str, payload: bytes, sub: str | None
    ) -> AgentSenderHeader:
        self._ensure_open()
        if self._identity is None or self._identity.signer is None:
            raise SenderSignatureRequiredError(subject)
        plan = await plan_sender_header(
            self._identity, self._nc, sub if sub is not None else subject, require_signed=True
        )
        if plan is None:  # unreachable with a signer; keeps the type checker honest
            raise SenderSignatureRequiredError(subject)
        return await plan.build(payload)

    async def _signed_headers(
        self, subject: str, payload: bytes, sub: str | None, extra: Mapping[str, str] | None
    ) -> dict[str, str]:
        header = await self._signed_header(subject, payload, sub)
        hdrs: dict[str, str] = dict(extra) if extra else {}
        hdrs[AGENT_SENDER_HEADER] = serialize_sender_header(header)
        if header.nonce is not None:
            hdrs[NATS_MSG_ID_HEADER] = header.nonce
        return hdrs

    async def close(self) -> None:
        """Tear down SDK-owned state. Idempotent.

        Sets :attr:`close_event`, which every in-flight
        :meth:`Agent.prompt` iterator races against — they unblock
        within an event-loop tick instead of waiting on the inactivity
        timeout. Then unsubscribes the heartbeat wildcard. The shared
        reply-inbox mux is **not** torn down here — it lives on the
        connection (per-nc singleton in ``_mux.py``) and dies when the
        caller closes ``nc``. The underlying NATS connection itself is
        also NOT touched — the caller who opened it is responsible
        for closing it.
        """
        if self._closed:
            return
        self._closed = True
        self._close_event.set()
        await self._tracker.stop()

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("synadia_ai.agents.Agents is closed")


def _to_bytes(payload: bytes | str) -> bytes:
    return payload.encode("utf-8") if isinstance(payload, str) else payload


__all__ = ["DEFAULT_REQUEST_SIGNED_TIMEOUT_S", "NATS_MSG_ID_HEADER", "Agents"]

"""Per-NATS-connection shared mux inbox for prompt-stream replies.

INTERIM-NATSPY-REQUEST-MANY: this module is the Python-side workaround
for ``nats-py``'s missing ``request_many`` primitive. The TypeScript SDK
(see PR
[synadia-ai/synadia-agents#66](https://github.com/synadia-ai/synadia-agents/pull/66))
drives prompt streams through ``nc.requestMany(subject, payload, {
strategy: "sentinel", maxWait })`` — a method on the **NATS connection**
whose internal mux is automatically shared by every caller of the same
``nc``. ``nats-py`` has no equivalent (its internal mux at
``_resp_map`` / ``_resp_sub_prefix`` in ``nats/aio/client.py`` tracks one
``Future`` per token, not iterators).

This module is the API-level analogue, intentionally mirroring the TS
shape: **one** ``MuxInbox`` per :class:`~nats.aio.client.Client`,
created on first prompt and held in a process-global
:class:`weakref.WeakKeyDictionary` keyed by the connection. Every caller
of :func:`mux_for` against the same ``nc`` gets the same instance, so
multiple :class:`~synadia_ai.agents.Agents` (or directly-constructed
:class:`~synadia_ai.agents.Agent` handles) on the same connection
share one ``_INBOX.agents.<mux>.*`` subscription. Lifecycle is tied to
the connection: when the user closes ``nc`` the subscription dies, and
when *every* strong reference to the ``Client`` object is dropped the
weak-keyed cache entry is collected automatically — no explicit
teardown. Note the mux itself holds ``self._nc`` strongly, so the
cache only frees once the user (and any other code path) has released
their references too; with a long-lived caller this means the entry
persists for the lifetime of the process, by design.

Cancellation is **not** the mux's concern. The mux only routes
:class:`~nats.aio.msg.Msg` objects from inbox-tail token to per-stream
queue. Per-stream cancellation (``Agents.close()``,
``Agent.prompt()`` early bailout) is handled by the consumer in
:meth:`~synadia_ai.agents.agent.Agent._stream_prompt` via a
``close_event`` watcher task — the same separation TS uses between
``requestMany`` (transport) and ``closeSignal`` (cancellation).

When ``nats-py`` ships ``request_many`` upstream, this module is meant
to be **deleted** wholesale —
:meth:`~synadia_ai.agents.agent.Agent._stream_prompt` is the single
call site to migrate. Track the upstream feature at
[`nats-io/nats.py`](https://github.com/nats-io/nats.py).
"""

from __future__ import annotations

import asyncio
import contextlib
import weakref
from typing import TYPE_CHECKING

from ._inbox import SDK_INBOX_PREFIX, _nuid
from ._logging import get_logger

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg
    from nats.aio.subscription import Subscription

log = get_logger(__name__)


class MuxInbox:
    """Shared reply-inbox subscription for one NATS connection.

    Routed per stream by inbox-tail token. Construct via
    :func:`mux_for` rather than directly so every caller on the same
    connection gets the same instance.

    Wire layout::

        SUB  _INBOX.agents.<mux-nuid>.*    1  (one per connection)
        PUB  agents.prompt.{a}.{o}.{n}     -> reply=_INBOX.agents.<mux>.<token>

    Tokens are NATS nuids (``nats.nuid``), globally unique within the
    process — no token reuse, so a stale chunk arriving after a stream
    has been unregistered routes nowhere and is silently dropped at
    DEBUG.
    """

    def __init__(self, nc: NATSClient) -> None:
        self._nc = nc
        # The mux nuid lives between the prefix and the per-stream token
        # — it isolates this connection's caller-side reply subjects
        # from any other client account that shares the
        # ``_INBOX.agents.>`` permission grant.
        self._inbox_prefix = f"{SDK_INBOX_PREFIX}.{_nuid.next().decode()}"
        self._sub: Subscription | None = None
        # Queue is typed `object` because consumers (currently
        # ``agent.py``) push their own per-stream cancellation sentinels
        # alongside the wire :class:`~nats.aio.msg.Msg` values the mux
        # dispatches. Consumers disambiguate by ``is`` identity at read.
        self._routes: dict[str, asyncio.Queue[object]] = {}
        # `_started` flips True after the first successful start(); used
        # to make start() idempotent without re-subscribing.
        self._started = False
        # Serialises start() against itself; concurrent first prompts
        # race the SUB+flush exactly once.
        self._lock = asyncio.Lock()

    @property
    def inbox_prefix(self) -> str:
        """``_INBOX.agents.<mux-nuid>`` — the prefix this inbox listens on."""
        return self._inbox_prefix

    def reply_subject_for(self, token: str) -> str:
        """Return the per-stream reply subject for a registered token."""
        return f"{self._inbox_prefix}.{token}"

    async def start(self) -> None:
        """Subscribe + flush. Idempotent; safe to call from every prompt.

        If ``flush()`` raises after ``subscribe()`` has already returned
        a live :class:`~nats.aio.subscription.Subscription`, the partial
        sub is unsubscribed before the exception propagates. Otherwise a
        retry on the next prompt would call ``subscribe()`` again and
        overwrite ``self._sub``, leaking the original subscription on
        the broker until ``nc`` is closed.
        """
        if self._started:
            return
        async with self._lock:
            if self._started:  # second-check inside the lock
                return
            wildcard = f"{self._inbox_prefix}.*"
            sub = await self._nc.subscribe(wildcard, cb=self._on_msg)
            try:
                # Flush so the SUB lands at the broker before any caller
                # publishes a request that names this inbox as its reply.
                await self._nc.flush()
            except BaseException:
                # Roll back the half-started state so a retry from the
                # next prompt can subscribe cleanly.
                with contextlib.suppress(Exception):
                    await sub.unsubscribe()
                raise
            self._sub = sub
            self._started = True

    async def _on_msg(self, msg: Msg) -> None:
        """Route an inbound reply to its per-stream queue by tail token.

        Runs on the nats-py per-subscription dispatch task, which
        catches and reports exceptions from this callback to the
        connection's ``error_cb`` rather than tearing down the
        subscription. A late chunk for an unregistered token (e.g. a
        §9.3 trailing terminator after the consumer already raised on
        an error frame) routes nowhere and is dropped at DEBUG.
        """
        subject: str = msg.subject
        last_dot = subject.rfind(".")
        token = subject[last_dot + 1 :] if last_dot >= 0 else subject
        queue = self._routes.get(token)
        if queue is None:
            log.debug("mux: dropping reply for unregistered token (subject=%s)", subject)
            return
        queue.put_nowait(msg)

    def register(self) -> tuple[str, asyncio.Queue[object]]:
        """Reserve a per-stream token + queue.

        Returns ``(token, queue)``. The caller publishes its request
        with ``reply=mux.reply_subject_for(token)`` and pulls inbound
        chunks from ``queue``. After the stream completes (or is
        cancelled), the caller MUST call :meth:`unregister` to free
        the slot.
        """
        token = _nuid.next().decode()
        queue: asyncio.Queue[object] = asyncio.Queue()
        self._routes[token] = queue
        return token, queue

    def unregister(self, token: str) -> None:
        """Drop the routing entry for ``token``. Idempotent."""
        self._routes.pop(token, None)


# Process-global cache: one MuxInbox per NATS connection. WeakKeyDictionary
# means the entry drops when the user's ``Client`` object is GC'd, so the
# SDK never holds a connection alive longer than the user does.
_MUX_CACHE: weakref.WeakKeyDictionary[NATSClient, MuxInbox] = weakref.WeakKeyDictionary()


def mux_for(nc: NATSClient) -> MuxInbox:
    """Return the singleton :class:`MuxInbox` for ``nc``.

    Lazy-initialised on first call per connection. Subsequent calls on
    the same connection return the same instance, so multiple
    :class:`~synadia_ai.agents.Agents` and directly-constructed
    :class:`~synadia_ai.agents.Agent` handles share one
    ``_INBOX.agents.<mux>.*`` subscription. Mirrors the TS SDK's
    ``nc.requestMany`` shape, where the mux belongs to the connection
    and every caller picks it up automatically.

    Single-threaded asyncio + sync check-and-insert means concurrent
    first calls are safe without a lock.
    """
    mux = _MUX_CACHE.get(nc)
    if mux is None:
        mux = MuxInbox(nc)
        _MUX_CACHE[nc] = mux
    return mux


__all__ = ["MuxInbox", "mux_for"]

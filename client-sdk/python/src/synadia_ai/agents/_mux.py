"""Per-:class:`Agents` shared mux inbox for prompt-stream replies.

INTERIM-NATSPY-REQUEST-MANY: this module is the Python-side workaround
for ``nats-py``'s missing ``request_many`` primitive. The TypeScript SDK
(see PR
[synadia-ai/synadia-agents#66](https://github.com/synadia-ai/synadia-agents/pull/66))
drives prompt streams through ``nc.requestMany(subject, payload, {
strategy: "sentinel", maxWait })`` so replies route through the
connection's shared mux inbox instead of a fresh per-stream
``_INBOX.agents.>`` subscription. ``nats-py`` has no equivalent — its
internal mux (``_resp_map`` / ``_resp_sub_prefix`` in
``nats/aio/client.py``) tracks one ``Future`` per token, not iterators.

This module is the API-level analogue: one persistent
``_INBOX.agents.<mux>.*`` subscription per :class:`Agents`, with messages
routed by inbox-tail token to per-stream queues. Callers get the
wire-traffic savings (one SUB+flush per :class:`Agents` instance instead
of one per prompt) and the parity API on the prompt side
(``max_wait_s``, :class:`StreamMaxWaitExceededError`,
cancellation-safe teardown).

When ``nats-py`` ships ``request_many`` upstream, this module is meant
to be **deleted** — :meth:`Agent._stream_prompt` is the single call site
to migrate. The migration plan is tracked in
`client-sdk/python/CHANGELOG.md` under the entry that introduced this
module; track the upstream feature at
[`nats-io/nats.py`](https://github.com/nats-io/nats.py).
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import TYPE_CHECKING, Final

from ._inbox import SDK_INBOX_PREFIX, _nuid
from ._logging import get_logger
from .errors import AgentsClosedError

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg
    from nats.aio.subscription import Subscription

log = get_logger(__name__)


# Sentinel object placed into a per-stream queue when :meth:`MuxInbox.close`
# fires. The consumer (:meth:`Agent._stream_prompt`) recognises it via
# ``is`` identity and raises a clean cancellation error instead of waiting
# for the inactivity timeout against a torn-down subscription.
_AGENTS_CLOSED: Final[object] = object()


class MuxInbox:
    """One shared reply-inbox subscription, routed per stream by token.

    Owned by an :class:`Agents` instance (one per process, normally).
    Lazy-started: the SUB+flush is paid on the first :meth:`register`,
    so :class:`Agents` instances that only do discovery never open a
    reply-inbox subscription. Re-entrancy on :meth:`start` and
    :meth:`close` is safe and idempotent.

    Wire layout::

        SUB  _INBOX.agents.<mux-nuid>.*    1  (one per Agents)
        PUB  agents.prompt.{a}.{o}.{n}     -> reply=_INBOX.agents.<mux>.<token>

    Tokens are nuids (``nats.nuid``), globally unique within the
    process — no token reuse, so a stale chunk arriving after a stream
    has been unregistered routes nowhere and is silently dropped at
    DEBUG.
    """

    def __init__(self, nc: NATSClient) -> None:
        self._nc = nc
        # The mux nuid lives between the prefix and the per-stream token
        # — it isolates this :class:`Agents` instance from any other
        # caller sharing the same ``_INBOX.agents.>`` permission grant.
        self._inbox_prefix = f"{SDK_INBOX_PREFIX}.{_nuid.next().decode()}"
        self._sub: Subscription | None = None
        self._routes: dict[str, asyncio.Queue[Msg | object]] = {}
        # `_started` flips True after the first successful start(); used
        # to make start() idempotent without re-subscribing.
        self._started = False
        # `_closed` flips True at the start of close() — *before* the
        # sentinel broadcast — so a concurrent register() either races
        # in first (and gets the sentinel via close()'s sweep) or races
        # in second (and raises AgentsClosedError). See plan §race #7.
        self._closed = False
        # Held across check-then-mutate sections to keep close() and
        # register() linearly ordered against each other.
        self._lock = asyncio.Lock()

    @property
    def inbox_prefix(self) -> str:
        """``_INBOX.agents.<mux-nuid>`` — the prefix this inbox listens on."""
        return self._inbox_prefix

    def reply_subject_for(self, token: str) -> str:
        """Return the per-stream reply subject for a registered token."""
        return f"{self._inbox_prefix}.{token}"

    async def start(self) -> None:
        """Subscribe + flush. Idempotent; safe to call from every prompt."""
        if self._started:
            return
        async with self._lock:
            if self._started:  # second-check inside the lock
                return
            if self._closed:
                # Don't resurrect a torn-down inbox — surfaces as a
                # clean error from register().
                return
            wildcard = f"{self._inbox_prefix}.*"
            self._sub = await self._nc.subscribe(wildcard, cb=self._on_msg)
            # Flush so the SUB lands at the broker before any caller
            # publishes a request that names this inbox as its reply.
            await self._nc.flush()
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
        cancelled), the caller MUST call :meth:`unregister` to free the
        slot.

        The check-and-insert is synchronous — no awaits between the
        ``self._closed`` test and the dict assignment — so a concurrent
        :meth:`close` either ran first (and this raises
        :class:`AgentsClosedError`) or runs second (and the sentinel
        broadcast in close() finds the token).
        """
        if self._closed:
            raise AgentsClosedError("Agents is closed; cannot start new prompt streams")
        # Shared module-level NUID; nuids are globally unique within the
        # process — no token collision risk across concurrent prompts.
        token = _nuid.next().decode()
        queue: asyncio.Queue[object] = asyncio.Queue()
        self._routes[token] = queue
        return token, queue

    def unregister(self, token: str) -> None:
        """Drop the routing entry for ``token``. Idempotent."""
        self._routes.pop(token, None)

    async def close(self) -> None:
        """Tear down. Broadcasts a sentinel to every live queue, then unsubscribes.

        Idempotent. After :meth:`close` returns, :meth:`register` raises
        :class:`AgentsClosedError` on every subsequent call.
        """
        if self._closed:
            return
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            # 1) Broadcast first so every consumer that's blocked on
            #    queue.get() unblocks promptly. Use put_nowait — the
            #    queue is unbounded, this never blocks.
            for queue in list(self._routes.values()):
                queue.put_nowait(_AGENTS_CLOSED)
            self._routes.clear()
            # 2) Then drop the subscription. Order matters: if we
            #    unsubscribed first, an inbound message could try to
            #    enqueue against a queue we're about to abandon.
            sub = self._sub
            self._sub = None
        if sub is not None:
            with contextlib.suppress(Exception):
                await sub.unsubscribe()


def is_agents_closed_sentinel(value: object) -> bool:
    """``True`` iff ``value`` is the close-broadcast sentinel placed in queues."""
    return value is _AGENTS_CLOSED


__all__ = ["MuxInbox", "is_agents_closed_sentinel"]

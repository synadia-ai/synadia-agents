"""Single-reply request on the SDK-owned inbox prefix (internal).

``Client.request`` in nats-py answers on its own ``_INBOX.>`` mux; the SDK
keeps every caller-side reply subject under ``_INBOX.agents.>`` (see
:mod:`._inbox`) so one permission covers them all. ``request_one`` is the
transport behind ``Agent.status()``, ``Agents.request_signed()`` and the
``$SYS.REQ.USER.INFO`` lookup of ``self_id()``.
"""

from __future__ import annotations

import contextlib
import time
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING

from nats.errors import NoRespondersError

from ._inbox import new_inbox

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

_NO_RESPONDERS_STATUS = "503"
_STATUS_HEADER = "Status"


async def request_one(
    nc: NATSClient,
    subject: str,
    payload: bytes,
    *,
    timeout_s: float,
    headers: Mapping[str, str] | None = None,
    poll_s: float | None = None,
    abort_check: Callable[[], Exception | None] | None = None,
) -> Msg:
    """Publish ``payload`` to ``subject`` with a fresh SDK inbox and await one reply.

    Raises the builtin :class:`TimeoutError` (nats-py's subclass) when no
    reply arrives within ``timeout_s`` and
    :class:`~nats.errors.NoRespondersError` on a ``503`` status reply.

    ``abort_check`` is polled every ``poll_s`` seconds while waiting; when
    it returns an exception, that exception is raised at once. The
    ``self_id()`` lookup uses it to fail fast on a permissions violation
    the server reports asynchronously (``Client.last_error``) instead of
    burning the whole timeout.
    """
    inbox = new_inbox()
    sub = await nc.subscribe(inbox)
    try:
        await nc.publish(subject, payload, reply=inbox, headers=dict(headers) if headers else None)
        deadline = time.monotonic() + timeout_s
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"no reply on {subject} within {timeout_s:g}s")
            slice_s = min(remaining, poll_s) if poll_s is not None else remaining
            try:
                msg = await sub.next_msg(timeout=slice_s)
            except TimeoutError:
                if abort_check is not None:
                    exc = abort_check()
                    if exc is not None:
                        raise exc from None
                continue
            break
    finally:
        with contextlib.suppress(Exception):
            await sub.unsubscribe()
    if msg.headers and msg.headers.get(_STATUS_HEADER) == _NO_RESPONDERS_STATUS:
        raise NoRespondersError
    return msg


__all__ = ["request_one"]

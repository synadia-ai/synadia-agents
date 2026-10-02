"""Request interceptors — the host-side hook around a prompt handler.

:class:`~synadia_ai.agent_service.AgentService` runs its interceptors for
every admitted ``prompt`` request: after the envelope is decoded and the
sender classified, before the §6.4 ack. An interceptor sees the decoded
envelope — the fields the protocol does not define in
:attr:`~synadia_ai.agents.Envelope.extras` (§5.6) — the classified sender,
the subject and the request's headers. It may refuse the request by raising
before it calls ``call_next()``, and it may run ``call_next()`` inside a
:mod:`contextvars` binding of its own, which the handler and everything it
awaits then see. What the extra fields and headers mean is the
interceptor's business; the SDK gives them none. The TypeScript SDK's
``RequestInterceptor`` is the same hook.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from synadia_ai.agents import Envelope, SenderInfo

#: What an interceptor calls to go on: it acks the request, runs the
#: interceptors after this one and then the handler, and returns when they
#: are done — or raises what they raised.
CallNext = Callable[[], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class RequestInterceptorContext:
    """What a :class:`RequestInterceptor` sees."""

    #: The decoded envelope; top-level fields the protocol does not define are in ``extras``.
    envelope: Envelope
    #: The classified sender, as the handler gets it in ``PromptStream.sender``.
    sender: SenderInfo | None
    #: The subject the request arrived on.
    subject: str
    #: The request's NATS headers; empty when it carried none.
    headers: Mapping[str, str]


class RequestInterceptor(Protocol):
    """A host-side hook around the prompt handler.

    ``call_next()`` acks the request, runs the interceptors after this one
    and then the handler, and returns when they are done — or raises what
    they raised, which an interceptor may let through or replace. An
    interceptor must call it once or raise: returning without calling it
    answers the caller ``500``. An exception after ``call_next()`` returned
    — the handler's reply already out in full — leaves that reply standing
    and is logged with a fixed line, never the exception's details: an
    interceptor that wants those logged logs them itself.
    """

    async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None: ...


# §9 error codes: the client and server error classes of HTTP.
_MIN_ERROR_CODE = 400
_MAX_ERROR_CODE = 599


class RequestRejectedError(Exception):
    """Raised to refuse a request with a §9 error.

    :class:`~synadia_ai.agent_service.AgentService` answers with ``code``
    and ``description`` (single-lined and capped at 200 characters), then
    the terminator. Raised before ``call_next()``, the caller gets no ack.
    For a malformed request a :class:`~synadia_ai.agents.ProtocolError`
    (``400``) says the same.
    """

    def __init__(self, code: int, description: str) -> None:
        if (
            isinstance(code, bool)
            or not isinstance(code, int)
            or not _MIN_ERROR_CODE <= code <= _MAX_ERROR_CODE
        ):
            raise ValueError(f"RequestRejectedError: code must be an int in 400-599, got {code!r}")
        super().__init__(f"request rejected ({code}): {description}")
        #: The §9 status code, 400-599.
        self.code = code
        #: The description the caller sees in ``Nats-Service-Error``.
        self.description = description


__all__ = [
    "CallNext",
    "RequestInterceptor",
    "RequestInterceptorContext",
    "RequestRejectedError",
]

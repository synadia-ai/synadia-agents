"""Client-side ``Agent`` — a live handle returned by :meth:`Agents.discover`.

Wraps a parsed :class:`~synadia_ai.agents.discovery.AgentInfo` with the
:class:`~nats.aio.client.Client` needed to prompt it. Mirrors the TS
SDK's ``Agent`` class (PR #7): every field flat / read-only, ``prompt()``
is the one method that actually does I/O.

The server-side counterpart (``AgentService``) ships in the sibling
distribution :mod:`synadia_ai.agent_service`.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, TypeAlias

from ._logging import get_logger
from ._mux import MuxInbox, is_agents_closed_sentinel
from .discovery import AgentInfo, EndpointInfo
from .envelope import Attachment, Envelope, encode
from .errors import ProtocolError, StreamMaxWaitExceededError, StreamStalledError
from .messages import QueryChunk, ResponseChunk, StatusChunk, decode_chunk
from .validation import (
    assert_attachments_allowed,
    assert_prompt_non_empty,
    assert_within_max_payload,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

log = get_logger(__name__)


# Default per-stream inactivity timeout (§6.6) — 60 seconds. Mirrors the
# TS SDK's DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS.
DEFAULT_STREAM_INACTIVITY_TIMEOUT_S: float = 60.0


# Default absolute ceiling on a prompt stream — 10 minutes. Distinct from
# the §6.6 per-chunk inactivity timer: the inactivity timer resets every
# message, so a stream that emits a steady trickle of chunks could in
# principle run forever. ``max_wait_s`` is the safety net for that case
# and for silent reconnect windows that exceed the inactivity reset
# cycle. Mirrors the TS SDK's ``DEFAULT_PROMPT_MAX_WAIT_MS`` from
# `client-sdk/typescript`'s PR #66.
DEFAULT_PROMPT_MAX_WAIT_S: float = 600.0


@dataclass(frozen=True)
class Query:
    """A mid-stream question from the agent (§7).

    Yielded by the prompt iterator when the agent publishes a ``query`` chunk.
    Call :meth:`reply` exactly once to answer — the SDK publishes to
    ``reply_subject`` fire-and-forget (no agent ack, per §7.2).
    """

    id: str
    reply_subject: str
    prompt: str
    attachments: list[Attachment] | None
    _nc: NATSClient = field(repr=False)

    async def reply(self, answer: str | Envelope) -> None:
        """Send the caller's reply to this query (§7.2).

        ``str`` is sent via the §5.3 plain-text shorthand; an :class:`Envelope`
        is JSON-encoded. Multiple calls are a bug — §7.2 specifies exactly
        one reply per ``reply_subject``.
        """
        if isinstance(answer, str):
            payload = answer.encode("utf-8")
        elif isinstance(answer, Envelope):
            payload = encode(answer)
        else:
            raise TypeError(f"unsupported answer type: {type(answer).__name__}")
        await self._nc.publish(self.reply_subject, payload)


StreamMessage: TypeAlias = ResponseChunk | StatusChunk | Query
"""One item yielded by :meth:`Agent.prompt`'s async iterator."""


class Agent:
    """A live handle returned by :meth:`Agents.discover`.

    Carries the metadata parsed from ``$SRV.INFO`` (spec §4.3) plus the
    :class:`~nats.aio.client.Client` needed to prompt it. Every public
    field is read-only; group / filter agents with built-in Python
    primitives (list comprehensions, ``itertools.groupby``).

    Two construction paths:

    1. **From discovery** — :meth:`Agents.discover` builds these and
       wires the ``Agents``-owned close-event so :meth:`Agents.close`
       short-circuits any in-flight prompt streams.
    2. **From an explicit :class:`AgentInfo`** — pass the info you got
       from a heartbeat + ``$SRV.INFO.agents.{id}`` lookup. If you also
       want close-coordination, pass the :attr:`Agents.close_event` so
       :meth:`Agents.close` cancels in-flight streams on this handle too.
    """

    def __init__(
        self,
        nc: NATSClient,
        info: AgentInfo,
        *,
        stream_inactivity_timeout: float = DEFAULT_STREAM_INACTIVITY_TIMEOUT_S,
        prompt_max_wait_s: float = DEFAULT_PROMPT_MAX_WAIT_S,
        close_event: asyncio.Event | None = None,
        mux: MuxInbox | None = None,
    ) -> None:
        self._nc = nc
        self._info = info
        self._default_inactivity_timeout = stream_inactivity_timeout
        self._default_max_wait_s = prompt_max_wait_s
        self._close_event = close_event
        # When `mux` is None — i.e. the handle was constructed outside
        # `Agents` (e.g. from a heartbeat + `$SRV.INFO.agents.{id}`
        # direct lookup) — we lazy-allocate a private mux on the first
        # prompt(). All subsequent prompts on this Agent share that
        # subscription, so the wire-economy property still holds even
        # for direct callers; the SUB itself rides on `nc` and is
        # cleaned up when the caller closes the connection.
        self._mux = mux

    # --- flat read-only identity / capability fields -------------------

    @property
    def instance_id(self) -> str:
        """Service id — unique per running instance (matches ``heartbeat.instance_id``)."""
        return self._info.instance_id

    @property
    def agent(self) -> str:
        """``metadata.agent`` from the $SRV.INFO record (§3.2)."""
        return self._info.agent

    @property
    def owner(self) -> str:
        """``metadata.owner`` from the $SRV.INFO record (§3.2)."""
        return self._info.owner

    @property
    def session_name(self) -> str:
        """5th token of the prompt subject — the session this agent serves (v0.3).

        Empty string for custom prompt-endpoint subjects that don't follow
        the default ``agents.prompt.{agent}.{owner}.{session_name}`` layout
        (§4.3).
        """
        return self._info.session_name

    @property
    def protocol_version(self) -> str:
        """``metadata.protocol_version`` (verbatim — MAJOR.MINOR comparison is the caller's job)."""
        return self._info.protocol_version

    @property
    def description(self) -> str:
        """Service-level ``description`` from $SRV.INFO."""
        return self._info.description

    @property
    def version(self) -> str:
        """Harness semver from the service ``version`` field."""
        return self._info.version

    @property
    def metadata(self) -> Mapping[str, str]:
        """Full service metadata — unknown keys preserved per §5.6."""
        return self._info.metadata

    @property
    def endpoints(self) -> tuple[EndpointInfo, ...]:
        """All endpoints the agent registered (§4.3)."""
        return self._info.endpoints

    @property
    def prompt_endpoint(self) -> EndpointInfo:
        """The ``prompt`` endpoint — guaranteed present on every :class:`Agent`."""
        return self._info.prompt_endpoint

    @property
    def prompt_subject(self) -> str:
        """The prompt endpoint subject — taken verbatim from ``$SRV.INFO`` (§4.3)."""
        return self._info.prompt_endpoint.subject

    @property
    def info(self) -> AgentInfo:
        """The underlying :class:`AgentInfo` record (frozen)."""
        return self._info

    # --- prompt --------------------------------------------------------

    def prompt(
        self,
        text: str | Envelope,
        *,
        attachments: list[Attachment] | None = None,
        timeout: float | None = None,
        max_wait_s: float | None = None,
    ) -> AsyncIterator[StreamMessage]:
        """Send a prompt and return an async iterator of streamed messages.

        ``text`` is either a bare string or a fully-constructed
        :class:`Envelope`. ``attachments``, when provided, are attached to
        the envelope (per §5.1).

        Under v0.3 the session is the 5th subject token, not a kwarg —
        callers pick a session by discovering the agent whose
        ``session_name`` matches (e.g. ``DiscoverFilter(session_name=...)``).
        See ``CHANGELOG.md`` for the migration note.

        ``timeout`` is the per-message inactivity timeout in seconds;
        defaults to the value passed to the owning :class:`Agents` (60 s
        out of the box, §6.6).

        ``max_wait_s`` is the absolute ceiling on the whole stream —
        distinct from ``timeout``, which resets on every received chunk.
        Defaults to the value passed to the owning :class:`Agents`
        (10 minutes out of the box). Mirrors the TS SDK's
        ``PromptOptions.maxWaitMs`` from PR #66. On expiry the iterator
        raises :class:`StreamMaxWaitExceededError`; the inactivity-gap
        path raises :class:`StreamStalledError`. Both inherit from
        :class:`ProtocolError` so existing catch-broadly callers keep
        working.

        §5.4 pre-publish validation runs synchronously before any wire I/O.
        Failures raise:

        - :class:`PromptEmptyError` — empty prompt text (§5.1).
        - :class:`AttachmentsNotSupportedError` — attachments with
          ``attachments_ok=false`` (§5.4).
        - :class:`PayloadTooLargeError` — envelope exceeds ``max_payload``
          (§5.4).

        The iterator yields :class:`ResponseChunk` / :class:`StatusChunk` as
        the agent emits them and :class:`Query` when the agent asks a
        mid-stream question (§7) — the caller answers via
        ``await q.reply(...)`` without breaking the loop. The iterator
        terminates when the empty-payload chunk arrives (§6.5). Service
        errors mid-stream (§9) are raised as :class:`ProtocolError`.

        The iterator also short-circuits if the owning :class:`Agents`
        is closed mid-stream — the iterator raises a :class:`ProtocolError`
        describing the cancellation so callers don't silently hang on a
        broker that's already torn down.
        """
        if isinstance(text, Envelope):
            merged_attachments: list[Attachment] | None
            if attachments:
                merged_attachments = list(text.attachments or [])
                merged_attachments.extend(attachments)
            else:
                merged_attachments = list(text.attachments) if text.attachments else None
            envelope = Envelope(
                prompt=text.prompt,
                attachments=merged_attachments,
            )
        else:
            envelope = Envelope(
                prompt=text,
                attachments=list(attachments) if attachments else None,
            )

        # §5.4: local validation happens synchronously BEFORE any wire I/O.
        # Raising here means callers don't even allocate a reply subject.
        encoded = encode(envelope)
        assert_prompt_non_empty(envelope.prompt)
        ep = self._info.prompt_endpoint
        assert_attachments_allowed(bool(envelope.attachments), ep.attachments_ok)
        # The caller's own broker may enforce a smaller `max_payload` than
        # the agent advertises (multi-cluster / per-account configs); pass
        # `nc.max_payload` so the validator picks the smaller of the two.
        # Treat 0 / missing as "not declared" — the agent's value (or
        # nothing) governs.
        conn_limit = getattr(self._nc, "max_payload", 0) or None
        assert_within_max_payload(len(encoded), ep.max_payload_bytes, conn_limit)

        effective_timeout = timeout if timeout is not None else self._default_inactivity_timeout
        effective_max_wait = max_wait_s if max_wait_s is not None else self._default_max_wait_s
        return self._stream_prompt(envelope, encoded, effective_timeout, effective_max_wait)

    async def _wait_for_chunk(
        self,
        queue: asyncio.Queue[object],
        *,
        timeout: float,
        max_wait_s: float,
        deadline: float,
        reply: str,
        loop: asyncio.AbstractEventLoop,
    ) -> object:
        """Pull the next item off ``queue`` or raise the appropriate timeout.

        Splits the dual-timer logic out of :meth:`_stream_prompt` so the
        per-chunk decode loop stays readable. ``StreamMaxWaitExceededError``
        and ``StreamStalledError`` are disambiguated by which deadline
        elapsed first; both inherit from :class:`ProtocolError` for back-
        compat.
        """
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise StreamMaxWaitExceededError(max_wait_s)
        wait_for = min(timeout, remaining)
        try:
            return await asyncio.wait_for(queue.get(), timeout=wait_for)
        except TimeoutError as exc:
            if loop.time() >= deadline:
                raise StreamMaxWaitExceededError(max_wait_s) from exc
            log.warning("stream stalled on %s: no chunk within %.1fs", reply, timeout)
            raise StreamStalledError(timeout, reply_subject=reply) from exc

    async def _stream_prompt(
        self, envelope: Envelope, encoded: bytes, timeout: float, max_wait_s: float
    ) -> AsyncIterator[StreamMessage]:
        del envelope  # retained for readability at the call site; not needed here
        # Resolve the mux: shared (passed in by Agents) or private
        # (lazy-allocated for direct-construction callers). The wire
        # economy still holds — every Agent shares one SUB across all
        # of its prompts, regardless of how it was built.
        if self._mux is None:
            self._mux = MuxInbox(self._nc)
        mux = self._mux
        await mux.start()  # idempotent; pays SUB+flush on the first prompt
        token, queue = mux.register()
        reply = mux.reply_subject_for(token)
        subject = self._info.prompt_endpoint.subject

        # Absolute ceiling. ``loop.time()`` is monotonic so the deadline
        # is robust against wall-clock skew.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max_wait_s

        try:
            await self._nc.publish(subject, encoded, reply=reply)
            # Race: cancel() / Agents.close() may have fired during the
            # publish await. The mux's sentinel-broadcast lands in our
            # queue, but if close fired *before* we publish we still
            # want to fail fast rather than wait on a dead inbox.
            if self._close_event is not None and self._close_event.is_set():
                raise ProtocolError(
                    f"prompt stream cancelled: owning Agents is closed (reply={reply})"
                )

            while True:
                item = await self._wait_for_chunk(
                    queue,
                    timeout=timeout,
                    max_wait_s=max_wait_s,
                    deadline=deadline,
                    reply=reply,
                    loop=loop,
                )
                if is_agents_closed_sentinel(item):
                    raise ProtocolError(
                        f"prompt stream cancelled: owning Agents is closed (reply={reply})"
                    )

                msg: Msg = item  # type: ignore[assignment]
                headers = msg.headers or {}
                if "Nats-Service-Error-Code" in headers:
                    code = headers["Nats-Service-Error-Code"]
                    desc = headers.get("Nats-Service-Error", "")
                    log.warning("service error on %s: code=%s desc=%s", reply, code, desc)
                    raise ProtocolError(f"service error {code}: {desc}")

                if msg.data == b"" and not headers:
                    # §6.5: the terminator is a zero-byte body with NO headers.
                    # An empty body that carries headers (e.g. an error frame
                    # with no JSON context — §9.1) is explicitly not the
                    # terminator; §9.3 requires the error frame to precede
                    # the real empty-and-headerless terminator.
                    return
                chunk = decode_chunk(msg.data)
                if chunk is None:
                    # §6.6: unknown chunk types are silently ignored.
                    continue
                if isinstance(chunk, QueryChunk):
                    yield Query(
                        id=chunk.id,
                        reply_subject=chunk.reply_subject,
                        prompt=chunk.prompt,
                        attachments=(list(chunk.attachments) if chunk.attachments else None),
                        _nc=self._nc,
                    )
                else:
                    yield chunk
        finally:
            mux.unregister(token)


__all__ = [
    "DEFAULT_PROMPT_MAX_WAIT_S",
    "DEFAULT_STREAM_INACTIVITY_TIMEOUT_S",
    "Agent",
    "Query",
    "StreamMessage",
]

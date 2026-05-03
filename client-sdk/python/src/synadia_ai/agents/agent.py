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
import contextlib
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, TypeAlias

from ._logging import get_logger
from ._mux import mux_for
from .discovery import AgentInfo, EndpointInfo
from .envelope import Attachment, Envelope, encode
from .errors import (
    AgentsClosedError,
    ProtocolError,
    StreamMaxWaitExceededError,
    StreamStalledError,
)
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
    ) -> None:
        if prompt_max_wait_s <= 0:
            raise ValueError(f"prompt_max_wait_s must be > 0 (got {prompt_max_wait_s!r}).")
        self._nc = nc
        self._info = info
        self._default_inactivity_timeout = stream_inactivity_timeout
        self._default_max_wait_s = prompt_max_wait_s
        self._close_event = close_event

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
        Must be a positive float; ``None`` falls back to the value passed
        to the owning :class:`Agents` (10 minutes out of the box).
        Mirrors the TS SDK's ``PromptOptions.maxWaitMs`` from PR #66.
        On expiry the iterator raises :class:`StreamMaxWaitExceededError`;
        the inactivity-gap path raises :class:`StreamStalledError`. Both
        inherit from :class:`ProtocolError` so existing catch-broadly
        callers keep working. Passing ``max_wait_s <= 0`` raises
        :class:`ValueError` synchronously — there is no "no limit"
        sentinel, since an unbounded prompt stream is the exact failure
        mode this ceiling exists to prevent.

        §5.4 pre-publish validation runs synchronously before any wire I/O.
        Failures raise:

        - :class:`PromptEmptyError` — empty prompt text (§5.1).
        - :class:`AttachmentsNotSupportedError` — attachments with
          ``attachments_ok=false`` (§5.4).
        - :class:`PayloadTooLargeError` — envelope exceeds ``max_payload``
          (§5.4).
        - :class:`ValueError` — ``max_wait_s`` is not strictly positive.

        The iterator yields :class:`ResponseChunk` / :class:`StatusChunk` as
        the agent emits them and :class:`Query` when the agent asks a
        mid-stream question (§7) — the caller answers via
        ``await q.reply(...)`` without breaking the loop. The iterator
        terminates when the empty-payload chunk arrives (§6.5). Service
        errors mid-stream (§9) are raised as :class:`ProtocolError`.

        Cancellation:

        - If :meth:`Agents.close` has *already* fired before this
          iterator advances, :class:`AgentsClosedError` is raised
          before any wire I/O.
        - If :meth:`Agents.close` fires *during* iteration, the
          iterator raises :class:`ProtocolError` describing the
          cancellation within an event-loop tick — independent of
          ``timeout`` — so callers don't silently hang on a torn-down
          broker.
        - If the caller breaks out of the ``async for`` early, prefer
          ``async with contextlib.aclosing(agent.prompt(...)) as
          stream:`` (or an explicit ``await stream.aclose()``) so the
          per-stream slot in the shared mux inbox is freed
          deterministically. A bare ``break`` defers cleanup to the
          generator finalizer (works, but the slot lingers until GC).
        """
        if max_wait_s is not None and max_wait_s <= 0:
            raise ValueError(
                f"max_wait_s must be > 0 (got {max_wait_s!r}); pass None to use the default."
            )

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
        max_wait_event: asyncio.Event,
        reply: str,
    ) -> object:
        """Pull the next item off ``queue`` or raise the appropriate timeout.

        Close and max-wait are lifecycle controls, not ordinary queued
        stream values. They win over already-buffered chunks (including
        a buffered terminator) so :meth:`Agents.close` cannot be hidden
        behind FIFO backlog and max-wait does not drain arbitrary chunks
        after its deadline. The inactivity timeout remains a per-read
        gap detector and resets after every delivered item.

        Per-iteration task churn (``queue_task`` plus ``max_wait_task``
        and optionally ``close_task``, each cancelled on the loser side
        of the ``asyncio.wait`` race) is intentional. Lifting the
        event-wait tasks into :meth:`_stream_prompt` and reusing them
        across iterations would save a couple of ``create_task`` calls
        per slow-path read but at the cost of cleanup locality — the
        ``finally`` here is the single place that guarantees no task
        outlives the read it served. AI-stream chunk rates make the
        allocation cost invisible; the locality is what keeps the
        close-race contract auditable.
        """
        self._raise_if_cancelled(reply)
        if max_wait_event.is_set():
            raise StreamMaxWaitExceededError(max_wait_s)

        if not queue.empty():
            item = queue.get_nowait()
            self._raise_if_cancelled(reply)
            if max_wait_event.is_set():
                raise StreamMaxWaitExceededError(max_wait_s)
            return item

        queue_task: asyncio.Task[object] = asyncio.create_task(
            queue.get(),
            name=f"agents-prompt-next:{reply}",
        )
        max_wait_task: asyncio.Task[bool] = asyncio.create_task(
            max_wait_event.wait(),
            name=f"agents-prompt-max-wait:{reply}",
        )
        close_task: asyncio.Task[bool] | None = (
            asyncio.create_task(
                self._close_event.wait(),
                name=f"agents-prompt-close:{reply}",
            )
            if self._close_event is not None
            else None
        )
        wait_set: set[asyncio.Task[object] | asyncio.Task[bool]] = {
            queue_task,
            max_wait_task,
        }
        if close_task is not None:
            wait_set.add(close_task)

        try:
            done, _pending = await asyncio.wait(
                wait_set,
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                log.warning("stream stalled on %s: no chunk within %.1fs", reply, timeout)
                raise StreamStalledError(timeout, reply_subject=reply)
            if close_task is not None and close_task in done:
                raise ProtocolError(
                    f"prompt stream cancelled: owning Agents is closed (reply={reply})"
                )
            if max_wait_task in done:
                raise StreamMaxWaitExceededError(max_wait_s)

            item = queue_task.result()
            self._raise_if_cancelled(reply)
            if max_wait_event.is_set():
                raise StreamMaxWaitExceededError(max_wait_s)
            return item
        finally:
            for task in wait_set:
                if not task.done():
                    task.cancel()
                    with contextlib.suppress(BaseException):
                        await task

    def _raise_if_closed(self) -> None:
        """Raise :class:`AgentsClosedError` if the owning Agents has closed.

        Called at every point in :meth:`_stream_prompt` that is still
        pre-publish — top of method, and again immediately before the
        publish, since ``mux.start()`` may await for a non-trivial
        time on its first call (SUB + flush). Callers that have
        already entered the cleanup ``try`` block rely on the
        ``finally`` to drop the registered mux token.
        """
        if self._close_event is not None and self._close_event.is_set():
            raise AgentsClosedError("Agents is closed; cannot start new prompt streams")

    def _raise_if_cancelled(self, reply: str) -> None:
        """Raise if :meth:`Agents.close` fired during an active stream."""
        if self._close_event is not None and self._close_event.is_set():
            raise ProtocolError(f"prompt stream cancelled: owning Agents is closed (reply={reply})")

    async def _stream_prompt(
        self, envelope: Envelope, encoded: bytes, timeout: float, max_wait_s: float
    ) -> AsyncIterator[StreamMessage]:
        del envelope  # retained for readability at the call site; not needed here
        # Pre-flight: refuse outright if the owning Agents is already
        # closed. This catches the "called prompt() after close()" case
        # cleanly, before any wire I/O or mux state mutation.
        self._raise_if_closed()

        # Per-nc mux singleton — shared across every Agent on the same
        # connection. See `_mux.py`'s INTERIM-NATSPY-REQUEST-MANY note.
        mux = mux_for(self._nc)
        await mux.start()  # idempotent; pays SUB+flush on the first prompt
        # `max_wait_s > 0` is enforced at the public boundary (Agent.prompt
        # and the constructors), so we treat it as an invariant here.
        loop = asyncio.get_running_loop()
        max_wait_event = asyncio.Event()
        max_wait_handle = loop.call_later(max_wait_s, max_wait_event.set)

        def on_msg(msg: Msg) -> None:
            if msg.data == b"" and not (msg.headers or {}):
                max_wait_handle.cancel()

        token, queue = mux.register(on_msg=on_msg)
        try:
            reply = mux.reply_subject_for(token)
            subject = self._info.prompt_endpoint.subject

            # Re-check after the mux.start() await: close may have
            # fired during the SUB+flush window. Bail before publishing
            # rather than firing a request whose reply we won't consume.
            self._raise_if_closed()

            await self._nc.publish(subject, encoded, reply=reply)

            while True:
                item = await self._wait_for_chunk(
                    queue,
                    timeout=timeout,
                    max_wait_s=max_wait_s,
                    max_wait_event=max_wait_event,
                    reply=reply,
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
            # Ordering matters: cancel the max-wait timer first, then
            # unregister the token (no more wire chunks will be routed
            # here — _on_msg is sync body, so any in-flight call has
            # already completed before this line returns), then drain
            # anything that arrived between the consumer's last ``get()``
            # and now.
            # This releases :class:`~nats.aio.msg.Msg` payloads
            # deterministically rather than waiting on the queue's
            # own GC, which matters for streams that exit early with
            # large chunks still buffered.
            if max_wait_handle is not None:
                max_wait_handle.cancel()
            mux.unregister(token)
            while not queue.empty():
                queue.get_nowait()


__all__ = [
    "DEFAULT_PROMPT_MAX_WAIT_S",
    "DEFAULT_STREAM_INACTIVITY_TIMEOUT_S",
    "Agent",
    "Query",
    "StreamMessage",
]

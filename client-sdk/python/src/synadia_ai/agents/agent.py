"""Client-side ``Agent`` — a live handle returned by :meth:`Agents.discover`.

Wraps a parsed :class:`~synadia_ai.agents.discovery.AgentInfo` with the
:class:`~nats.aio.client.Client` needed to prompt it. Mirrors the TS
SDK's ``Agent`` class (PR #7): every field flat / read-only, ``prompt()``
and ``status()`` are the methods that actually do I/O.

Sender identity (extension): a handle carries an
:class:`~synadia_ai.agents.identity.Identity` only when its
:class:`Agents` client explicitly enables one. ``prompt()`` / ``status()``
then attach a live-bound signed header or an explicitly requested unsigned
claim; omission attaches nothing and performs no identity lookup.

The server-side counterpart (``AgentService``) ships in the sibling
distribution :mod:`synadia_ai.agent_service`.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, TypeAlias
from weakref import WeakSet

import pydantic

from ._logging import get_logger
from ._mux import mux_for
from ._request import request_one
from .discovery import STATUS_ENDPOINT_NAME, AgentInfo, EndpointInfo, MinSenderTrust
from .envelope import Attachment, Envelope, encode
from .errors import (
    AgentsClosedError,
    NatsAgentError,
    ProtocolError,
    SenderSignatureRequiredError,
    StreamMaxWaitExceededError,
    StreamStalledError,
)
from .heartbeat import HeartbeatPayload
from .identity.agent_id import AgentId
from .identity.options import Identity, plan_sender_header, sender_header_bound
from .messages import QueryChunk, ResponseChunk, StatusChunk, decode_chunk
from .trace import (
    TraceOptions,
    active_trace,
    build_edge_record,
    inherited_trace_options,
    random_thread_id,
    valid_tool_call_id,
)
from .validation import (
    assert_attachments_allowed,
    assert_prompt_non_empty,
    assert_within_max_payload,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

log = get_logger(__name__)

_SERVICE_ERROR_CODE_HEADER = "Nats-Service-Error-Code"
_SERVICE_ERROR_HEADER = "Nats-Service-Error"

# Set to the record id so a stream de-duplicates a record it already
# stored. Same string as agents.NATS_MSG_ID_HEADER, spelled again here
# because agents.py imports this module.
_MSG_ID_HEADER = "Nats-Msg-Id"

# Connections already warned that their edge records go nowhere. One
# warning per connection: a per-prompt log would itself be a way for
# observability to disturb an agent.
_warned_unsigned: WeakSet[NATSClient] = WeakSet()

# Default `Agent.status()` request timeout — 2 seconds (mirrors the TS
# SDK's DEFAULT_STATUS_TIMEOUT_MS).
DEFAULT_STATUS_TIMEOUT_S: float = 2.0


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


def _override_lineage(
    envelope: Envelope,
    thread_id: str | None,
    root_id: str | None,
    parent_id: str | None,
) -> tuple[str | None, str | None]:
    """Let an explicit ``Envelope`` override the minted lineage.

    The pair travels together on the wire, so an overridden thread with no
    root of its own starts its own tree — exactly as a minted one does, and
    exactly as the agent service does when it adopts an ID-less envelope.
    Splicing the minted root onto it instead would name a root that is
    neither this thread nor any ancestor of it. Inside a handler
    (``parent_id`` set) the ambient root wins: the overridden thread is
    still part of that tree.

    An envelope naming this execution's own thread is the incoming
    envelope being forwarded — the most natural relay code hands what it
    received straight to a sub-agent. Forwarding spawns a thread, it does
    not continue one: honouring that id would file the sub-agent's
    execution under its parent's thread, collapsing the two into one and
    recording an edge from a thread to itself. So the minted thread stands
    and the envelope's id remains what it already is: the parent.
    """
    if envelope.thread_id is not None and envelope.thread_id != parent_id:
        thread_id = envelope.thread_id
        if envelope.root_id is None and parent_id is None:
            root_id = thread_id
    if envelope.root_id is not None:
        root_id = envelope.root_id
    return thread_id, root_id


@dataclass(frozen=True, slots=True)
class _EdgePlan:
    """What :meth:`Agent.prompt` decided to record; built into a record at publish time.

    The lineage is fixed when the prompt is planned — that is when the
    ambient trace is still the caller's — but the record's ``ts`` must say
    when the prompt actually went out and its ``agent`` is whoever signs
    it, so the bytes are produced by :meth:`Agent._publish_edge`
    immediately before the publish.
    """

    subject: str
    thread_id: str
    parent_id: str | None
    root_id: str
    tool_call_id: str | None
    turn_count_hint: int


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
       :meth:`Agents.close` cancels in-flight streams on this handle too;
       pass ``identity=`` (the :class:`Agents` client's) so requests
       carry an ``Agent-Sender`` header — a handle built without it
       sends none.
    """

    def __init__(
        self,
        nc: NATSClient,
        info: AgentInfo,
        *,
        stream_inactivity_timeout: float = DEFAULT_STREAM_INACTIVITY_TIMEOUT_S,
        prompt_max_wait_s: float = DEFAULT_PROMPT_MAX_WAIT_S,
        close_event: asyncio.Event | None = None,
        identity: Identity | None = None,
        trace: TraceOptions | None = None,
    ) -> None:
        if prompt_max_wait_s <= 0:
            raise ValueError(f"prompt_max_wait_s must be > 0 (got {prompt_max_wait_s!r}).")
        self._nc = nc
        self._info = info
        self._default_inactivity_timeout = stream_inactivity_timeout
        self._default_max_wait_s = prompt_max_wait_s
        self._close_event = close_event
        self._sender_identity = identity
        self._trace = trace

    @property
    def tracing_enabled(self) -> bool:
        """``True`` iff tracing was enabled on this handle."""
        return self._trace is not None

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

    # --- sender-identity extension (mirrors AgentInfo) ------------------

    @property
    def supports_sender_identity(self) -> bool:
        """``True`` iff the prompt endpoint advertises ``min_sender_trust``."""
        return self._info.supports_sender_identity

    @property
    def min_sender_trust(self) -> MinSenderTrust:
        """``min_sender_trust`` of the prompt endpoint (``"any"`` for a 0.3 agent)."""
        return self._info.prompt_endpoint.min_sender_trust

    @property
    def identity(self) -> AgentId | None:
        """The agent ID the instance registered, when present and well-formed."""
        return self._info.identity

    @property
    def id_sig_verified(self) -> bool:
        """``True`` iff the registration's ``id_sig`` verifies over the prompt subject."""
        return self._info.id_sig_verified

    # --- prompt --------------------------------------------------------

    def prompt(
        self,
        text: str | Envelope,
        *,
        attachments: list[Attachment] | None = None,
        timeout: float | None = None,
        max_wait_s: float | None = None,
        subject: str | None = None,
        sub: str | None = None,
        tool_call_id: str | None = None,
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

        ``tool_call_id`` is the ID of the model tool call this prompt
        serves, used to label the trace edge when tracing is enabled.

        §5.4 pre-publish validation runs synchronously before any wire I/O.
        Failures raise:

        - :class:`PromptEmptyError` — empty prompt text (§5.1).
        - :class:`AttachmentsNotSupportedError` — attachments with
          ``attachments_ok=false`` (§5.4).
        - :class:`PayloadTooLargeError` — envelope (plus the sound upper
          bound of an ``Agent-Sender`` header, when one may be sent)
          exceeds ``max_payload`` (§5.4).
        - :class:`ValueError` — ``max_wait_s`` is not strictly positive.
        - :class:`SenderSignatureRequiredError` — the endpoint declares
          ``min_sender_trust: signed`` and no ``Identity.signer`` is
          configured.

        Sender identity (extension): with an :class:`Agents`-supplied
        identity the request carries an ``Agent-Sender`` header, signed
        at publish time over the exact envelope bytes. Errors that need
        the async identity lookup surface on the first ``__anext__``:
        :class:`NoIdentityError` / :class:`IdentityUnavailableError` on a
        ``signed`` endpoint, :class:`IdentityMismatchError` whenever a
        signer is configured, and the exact :class:`PayloadTooLargeError`
        re-check once the header size is known.

        ``subject`` / ``sub`` are for callers behind a remapping service
        import: ``subject`` is what to publish to (default: the
        discovered prompt endpoint subject — behind an export that
        inserts the caller's account token, or a ``to:`` /
        ``local_subject`` rename by your own account, pass the local
        name); ``sub`` is what to sign (default: ``subject``) — only for
        a rename by **your own** account pass the exporter's subject,
        ``agent.prompt_endpoint.subject``.

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

        # Tracing is best-effort and shouldn't stop an agent from
        # sending out a prompt. Invalid tools are just ignored.
        if tool_call_id is not None and not valid_tool_call_id(tool_call_id):
            tool_call_id = None

        # Effective configuration: this handle's own, else the one handed
        # down by the enclosing AgentService, else tracing is off.
        trace_options = self._trace if self._trace is not None else inherited_trace_options()

        # If tracing is enabled, mint a thread ID for this prompt
        thread_id: str | None = None
        root_id: str | None = None
        parent_id: str | None = None
        turn_count_hint = 0
        if trace_options is not None:
            thread_id = random_thread_id()
            ambient = active_trace()
            if ambient is None:
                root_id = thread_id
                parent_id = None
            else:
                root_id = ambient.root_id
                parent_id = ambient.thread_id
                turn_count_hint = ambient.turn_count_hint[0]

        if isinstance(text, Envelope):
            merged_attachments: list[Attachment] | None
            if attachments:
                merged_attachments = list(text.attachments or [])
                merged_attachments.extend(attachments)
            else:
                merged_attachments = list(text.attachments) if text.attachments else None

            # Only a tracing client honours the envelope's lineage. With
            # tracing off the fields are dropped like any other extra, so an
            # untraced relay that forwards what it received sends a plain
            # v0.3 envelope — exactly what it sent before tracing existed —
            # rather than filing the sub-agent under its own thread.
            if trace_options is not None:
                thread_id, root_id = _override_lineage(text, thread_id, root_id, parent_id)

            envelope = Envelope(
                prompt=text.prompt,
                attachments=merged_attachments,
                thread_id=thread_id,
                root_id=root_id,
            )
        else:
            envelope = Envelope(
                prompt=text,
                attachments=list(attachments) if attachments else None,
                thread_id=thread_id,
                root_id=root_id,
            )

        # We do this after constructing the envelope to allow
        # overriding fields. Only the plan is made here — the record,
        # signing and the publish happen in _stream_prompt, at publish time.
        edge_publish = (
            self._plan_edge(
                trace_options, thread_id, parent_id, root_id, tool_call_id, turn_count_hint
            )
            if trace_options is not None and thread_id is not None and root_id is not None
            else None
        )

        # §5.4: local validation happens synchronously BEFORE any wire I/O.
        # Raising here means callers don't even allocate a reply subject.
        encoded = encode(envelope)
        assert_prompt_non_empty(envelope.prompt)
        ep = self._info.prompt_endpoint
        assert_attachments_allowed(bool(envelope.attachments), ep.attachments_ok)

        publish_subject = subject if subject is not None else ep.subject
        signed_subject = sub if sub is not None else publish_subject
        require_signed = ep.min_sender_trust == "signed"
        identity = self._sender_identity
        if require_signed and (identity is None or identity.signer is None):
            raise SenderSignatureRequiredError(publish_subject)

        # The caller's own broker may enforce a smaller `max_payload` than
        # the agent advertises (multi-cluster / per-account configs); pass
        # `nc.max_payload` so the validator picks the smaller of the two.
        # Treat 0 / missing as "not declared" — the agent's value (or
        # nothing) governs. The `Agent-Sender` header counts too: a sound
        # upper bound is applied here, synchronously; the exact size is
        # re-checked in `_stream_prompt` once the identity is known.
        conn_limit = getattr(self._nc, "max_payload", 0) or None
        header_bound = sender_header_bound(identity, self._nc, signed_subject)
        assert_within_max_payload(len(encoded), ep.max_payload_bytes, conn_limit, header_bound)

        effective_timeout = timeout if timeout is not None else self._default_inactivity_timeout
        effective_max_wait = max_wait_s if max_wait_s is not None else self._default_max_wait_s
        return self._stream_prompt(
            encoded,
            effective_timeout,
            effective_max_wait,
            subject=publish_subject,
            sub=signed_subject,
            require_signed=require_signed,
            edge_publish=edge_publish,
        )

    # --- status --------------------------------------------------------

    async def status(
        self,
        *,
        subject: str | None = None,
        sub: str | None = None,
        timeout_s: float = DEFAULT_STATUS_TIMEOUT_S,
    ) -> HeartbeatPayload:
        """Probe the agent's ``status`` endpoint (§8.7) and return its heartbeat payload.

        Attaches an ``Agent-Sender`` header like :meth:`prompt` does (the
        receiver classifies it, never rejects on it). A single request on
        the SDK inbox with an empty payload (which hashes to the SHA-256
        of zero bytes). ``subject`` / ``sub`` are the same overrides as on
        :meth:`prompt`.

        Raises :class:`NatsAgentError` when the agent declares no
        ``status`` endpoint and no ``subject`` was given,
        :class:`ProtocolError` on an error-headered reply or a reply that
        is not a §8.3 heartbeat payload, :class:`TimeoutError` /
        :class:`~nats.errors.NoRespondersError` from the transport, and
        configured-signer identity errors when its live connection binding
        cannot be established. Without a signer, an unavailable optional
        unsigned identity means "no header".
        """
        endpoint = next((e for e in self.endpoints if e.name == STATUS_ENDPOINT_NAME), None)
        publish_subject = (
            subject if subject is not None else (endpoint.subject if endpoint is not None else None)
        )
        if publish_subject is None:
            raise NatsAgentError(f"agent {self.instance_id} declares no status endpoint")
        signed_subject = sub if sub is not None else publish_subject
        plan = await plan_sender_header(
            self._sender_identity, self._nc, signed_subject, require_signed=False
        )
        headers = await plan.build_headers(b"") if plan is not None else None
        msg = await request_one(
            self._nc, publish_subject, b"", timeout_s=timeout_s, headers=headers
        )
        reply_headers = msg.headers or {}
        if _SERVICE_ERROR_CODE_HEADER in reply_headers:
            code = reply_headers[_SERVICE_ERROR_CODE_HEADER]
            desc = reply_headers.get(_SERVICE_ERROR_HEADER, "")
            raise ProtocolError(f"service error {code}: {desc}")
        try:
            return HeartbeatPayload.model_validate_json(msg.data)
        except pydantic.ValidationError as exc:
            raise ProtocolError("status reply is not a §8.3 heartbeat payload") from exc

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

    def _plan_edge(
        self,
        trace_options: TraceOptions,
        thread_id: str,
        parent_id: str | None,
        root_id: str,
        tool_call_id: str | None,
        turn_count_hint: int,
    ) -> _EdgePlan | None:
        """The edge to publish, or ``None`` for nothing.

        Split out of :meth:`prompt` only to keep that method within
        ruff's statement budget.
        """
        if trace_options.edge_subject is None:
            return None
        # Consumers ignore unsigned records, so publishing without a
        # signer would be pure waste: warn once per connection and skip.
        # Minting and envelope lineage need no identity and still happen,
        # so downstream agents that do have one keep tracing.
        identity = self._sender_identity
        if identity is None or identity.signer is None:
            if self._nc not in _warned_unsigned:
                _warned_unsigned.add(self._nc)
                log.warning(
                    "tracing is enabled but no identity signer is configured; edge "
                    "records are not published (consumers ignore unsigned records). "
                    "Pass identity=Identity(signer=...) to sign them."
                )
            return None
        return _EdgePlan(
            trace_options.edge_subject, thread_id, parent_id, root_id, tool_call_id, turn_count_hint
        )

    async def _publish_edge(self, edge_publish: _EdgePlan) -> None:
        """Build and publish one signed edge record.

        The signature covers the short-form subject the record is
        published to: per the identity design a remap that only drops the
        account token is not a rename, so no ``sub`` override is needed.
        Consumers verify in stored mode. The record's ``agent`` is the
        identity the header plan resolved — the same one that signs it —
        so body and header agree.

        Fail-open — tracing never fails a prompt.
        """
        subject = edge_publish.subject
        try:
            plan = await plan_sender_header(
                self._sender_identity, self._nc, subject, require_signed=True
            )
            if plan is None:  # pragma: no cover — guarded in _plan_edge
                raise SenderSignatureRequiredError(subject)
            record_id, payload = build_edge_record(
                plan.id,
                edge_publish.thread_id,
                edge_publish.parent_id,
                edge_publish.root_id,
                edge_publish.tool_call_id,
                edge_publish.turn_count_hint,
            )
            headers = await plan.build_headers(payload)
            headers[_MSG_ID_HEADER] = record_id
            await self._nc.publish(subject, payload, headers=headers)
        except Exception:
            log.exception("failed to publish edge record on %s", subject)

    async def _stream_prompt(
        self,
        encoded: bytes,
        timeout: float,
        max_wait_s: float,
        *,
        subject: str,
        sub: str,
        require_signed: bool,
        edge_publish: _EdgePlan | None = None,
    ) -> AsyncIterator[StreamMessage]:
        # Pre-flight: refuse outright if the owning Agents is already
        # closed. This catches the "called prompt() after close()" case
        # cleanly, before any wire I/O or mux state mutation.
        self._raise_if_closed()

        # Establish the reply mux before resolving identity. Its first start
        # pays a SUB+flush await; putting that one-time transport setup first
        # prevents a reconnect during the flush from leaving a pre-flush
        # identity plan ready to publish.
        mux = mux_for(self._nc)
        await mux.start()
        self._raise_if_closed()

        # Resolve the live identity as late as nats-py allows and re-check
        # `max_payload` with the exact header size. nats-py exposes no
        # reconnect generation, so a reconnect after this lookup and before
        # publish cannot yet be detected; adopting one when available is the
        # remaining target. The header is signed at publish time.
        plan = await plan_sender_header(
            self._sender_identity, self._nc, sub, require_signed=require_signed
        )
        if plan is not None:
            ep = self._info.prompt_endpoint
            conn_limit = getattr(self._nc, "max_payload", 0) or None
            assert_within_max_payload(
                len(encoded), ep.max_payload_bytes, conn_limit, plan.wire_bytes
            )

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

            # Re-check after identity lookup: close may have fired while the
            # live binding request was in flight. Bail before publishing
            # rather than firing a request whose reply we won't consume.
            self._raise_if_closed()

            # Signed at publish time so `ts` / nonce are fresh even when the
            # caller iterates late; the signature covers exactly `encoded`.
            # Built BEFORE the edge record goes out: signing can still fail,
            # and an edge record is a claim that a prompt was sent, so
            # nothing may be published until that claim is certain.
            headers = await plan.build_headers(encoded) if plan is not None else None

            # Observability: publish the edge before the prompt goes out, so
            # an observer sees the node before it runs.
            if edge_publish is not None:
                await self._publish_edge(edge_publish)

            await self._nc.publish(subject, encoded, reply=reply, headers=headers)

            while True:
                item = await self._wait_for_chunk(
                    queue,
                    timeout=timeout,
                    max_wait_s=max_wait_s,
                    max_wait_event=max_wait_event,
                    reply=reply,
                )

                msg: Msg = item  # type: ignore[assignment]
                reply_headers = msg.headers or {}
                if _SERVICE_ERROR_CODE_HEADER in reply_headers:
                    code = reply_headers[_SERVICE_ERROR_CODE_HEADER]
                    desc = reply_headers.get(_SERVICE_ERROR_HEADER, "")
                    log.warning("service error on %s: code=%s desc=%s", reply, code, desc)
                    raise ProtocolError(f"service error {code}: {desc}")

                if msg.data == b"" and not reply_headers:
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
            max_wait_handle.cancel()
            mux.unregister(token)
            while not queue.empty():
                queue.get_nowait()


__all__ = [
    "DEFAULT_PROMPT_MAX_WAIT_S",
    "DEFAULT_STATUS_TIMEOUT_S",
    "DEFAULT_STREAM_INACTIVITY_TIMEOUT_S",
    "Agent",
    "Query",
    "StreamMessage",
]

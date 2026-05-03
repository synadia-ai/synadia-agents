"""SDK exceptions.

All SDK errors inherit from :class:`NatsAgentError` so callers can branch on
one base class. Pre-publish validation errors (§5.4) live under
:class:`ValidationError`; wire-level errors (malformed frames, unparseable
subjects) live under :class:`ProtocolError`.
"""

from __future__ import annotations


class NatsAgentError(Exception):
    """Base for all SDK-raised errors."""


class ProtocolError(NatsAgentError):
    """Wire payload violates the NATS Agent Protocol (malformed envelope, bad chunk, etc.)."""


class StreamStalledError(ProtocolError):
    """Per-chunk inactivity timeout (§6.6) elapsed without a new chunk arriving.

    Inherits from :class:`ProtocolError` so existing ``except ProtocolError``
    clauses keep catching the stalled case; new code may catch this subclass
    to distinguish it from :class:`StreamMaxWaitExceededError` (the absolute
    ceiling) and from genuine wire-shape violations.
    """

    def __init__(self, timeout_s: float, *, reply_subject: str | None = None) -> None:
        loc = f" on {reply_subject}" if reply_subject else ""
        super().__init__(f"stream stalled: no chunk received within {timeout_s}s{loc}")
        self.timeout_s = timeout_s
        self.reply_subject = reply_subject


class StreamMaxWaitExceededError(ProtocolError):
    """Absolute ``max_wait_s`` ceiling on a prompt stream elapsed.

    Distinct from :class:`StreamStalledError` (the inactivity gap detector
    from §6.6). The ceiling is the safety net for cases where chunks keep
    arriving steadily but the agent never terminates — e.g. a misbehaving
    handler emitting a heartbeat-style ack every few seconds forever, or
    a silent reconnect window that exceeds the inactivity timer's
    per-message reset cycle. Inherits from :class:`ProtocolError` for
    back-compat with broad ``except ProtocolError`` clauses.
    """

    def __init__(self, max_wait_s: float) -> None:
        super().__init__(f"prompt stream exceeded max_wait_s={max_wait_s}s ceiling")
        self.max_wait_s = max_wait_s


class AgentsClosedError(NatsAgentError):
    """Raised when :meth:`Agent.prompt` is called after :meth:`Agents.close`.

    Pre-flight check at the top of every prompt stream: if the
    ``close_event`` is already set, the iterator raises this error
    before any wire I/O instead of hanging on a torn-down broker.
    Distinct from :class:`ProtocolError` (which the iterator raises
    when ``Agents.close`` fires *during* an active stream) so callers
    can branch on "already closed at call time" vs "torn down
    mid-flight" if they care.
    """

    def __init__(self, what: str = "Agents is closed") -> None:
        super().__init__(what)


class InvalidSubjectToken(NatsAgentError):
    """A subject token (agent / owner / name) breaks §2 constraints and can't be sanitized."""


class AgentNotFound(NatsAgentError):
    """The caller tried to bind or ping an agent that is not present on this NATS."""


class QueryTimeout(NatsAgentError):
    """A mid-stream query received no reply within the agent's timeout. (Reserved, §4.5.)"""


class ValidationError(NatsAgentError):
    """Pre-publish validation failure (§5.4)."""


class PromptEmptyError(ValidationError):
    """``prompt`` field is empty — §5.1 requires non-empty text."""

    def __init__(self) -> None:
        super().__init__("prompt must be non-empty (§5.1)")


class AttachmentsNotSupportedError(ValidationError):
    """Attachments supplied but the endpoint declared ``attachments_ok: false`` (§5.4)."""

    def __init__(self) -> None:
        super().__init__(
            "this agent's prompt endpoint does not accept attachments (attachments_ok=false, §5.4)"
        )


class PayloadTooLargeError(ValidationError):
    """Serialized envelope exceeds the endpoint's declared ``max_payload`` (§5.4)."""

    def __init__(self, *, limit: int, actual: int) -> None:
        super().__init__(
            f"payload size {actual} bytes exceeds endpoint max_payload of {limit} bytes (§5.4)"
        )
        self.limit = limit
        self.actual = actual


class NatsContextError(NatsAgentError):
    """Failure resolving a ``nats`` CLI context via :func:`load_context_options`.

    Single error class for every failure mode of context loading: missing
    file, malformed JSON, illegal context name, unsupported field
    (``nkey`` / TLS triple / ``nsc``), missing ``creds`` file, etc. The
    message carries actionable detail; callers branch on the class, not
    on a more specific type.
    """

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

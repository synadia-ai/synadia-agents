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


class ContextNotFoundError(NatsAgentError):
    """A named NATS context file is missing under ``<nats config>/context/``."""

    def __init__(self, name: str, path: str) -> None:
        super().__init__(
            f"nats context {name!r} not found at {path} — try `nats context ls` "
            "to see which contexts exist, or `nats context add {name} --server=...` "
            "to create one"
        )
        self.name = name
        self.path = path


class ContextInvalidError(NatsAgentError):
    """A NATS context file is present but malformed, unparseable, or uses an unsupported field."""

    def __init__(self, name: str, reason: str) -> None:
        super().__init__(f"nats context {name!r} is invalid: {reason}")
        self.name = name
        self.reason = reason


class ContextNotSelectedError(NatsAgentError):
    """``connect(context=True)`` was called but no context is selected.

    The resolver honours ``$NATS_CONTEXT`` first, then the selection file
    written by ``nats context select``. Neither was set, so there is nothing
    to load.
    """

    def __init__(self, selection_file: str) -> None:
        super().__init__(
            "no NATS context selected: neither $NATS_CONTEXT is set nor "
            f"{selection_file} names a context — run `nats context select <name>` "
            "or pass `context=<name>` explicitly"
        )
        self.selection_file = selection_file


class ContextNotSupportedError(ContextInvalidError):
    """A context uses a field natsagent does not yet implement (e.g. ``nkey``, TLS, ``nsc``)."""

    def __init__(self, name: str, field: str) -> None:
        super().__init__(
            name,
            f"`{field}` support is not yet implemented in natsagent; use `creds` / "
            "a credentials file if possible, or open an issue at "
            "https://github.com/synadia-ai/synadia-agents/issues",
        )
        self.field = field

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
    """Wire payload violates the Synadia Agent Protocol for NATS.

    (malformed envelope, bad chunk, etc.)
    """


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
    """Serialized envelope exceeds the endpoint's declared ``max_payload`` (§5.4).

    ``header_bytes`` is the framed wire size of the ``Agent-Sender`` header
    the request would have carried (sender-identity extension) — the
    server applies ``max_payload`` to headers and payload together, so the
    check counts both. Zero when no header is sent.
    """

    def __init__(self, *, limit: int, actual: int, header_bytes: int = 0) -> None:
        if header_bytes > 0:
            message = (
                f"payload size {actual} bytes plus Agent-Sender header {header_bytes} bytes "
                f"exceeds endpoint max_payload of {limit} bytes (§5.4)"
            )
        else:
            message = (
                f"payload size {actual} bytes exceeds endpoint max_payload of {limit} bytes (§5.4)"
            )
        super().__init__(message)
        self.limit = limit
        self.actual = actual
        self.header_bytes = header_bytes


class NatsContextError(NatsAgentError):
    """Failure resolving a ``nats`` CLI context via :func:`load_context_options`.

    Single error class for every failure mode of context loading: missing
    file, malformed JSON, illegal context name, unsupported field
    (``nkey`` / TLS triple / ``nsc``), missing ``creds`` file, etc. The
    message carries actionable detail; callers branch on the class, not
    on a more specific type.
    """


# --- sender-identity extension ------------------------------------------


class IdentityError(NatsAgentError):
    """Base for every sender-identity error (not a :class:`ValidationError`)."""


class NoIdentityError(IdentityError):
    """The server answered ``$SYS.REQ.USER.INFO`` but the connection has no NKEY user.

    No authentication, a password or token user, or a config-mode account
    name the canonical agent-ID form cannot carry. The message names the
    fix.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(
            f"this connection has no NKEY identity ({reason}); configure an nkey user on "
            "the server and connect with its seed, or connect with a credentials file"
        )
        self.reason = reason


class IdentityUnavailableError(IdentityError):
    """The SDK does not know the connection's identity.

    ``$SYS.REQ.USER.INFO`` did not answer within the timeout, a permission
    blocks it, or the two identity sources (credentials JWT, server)
    disagree.
    """

    def __init__(self, message: str) -> None:
        super().__init__(f"identity unavailable: {message}")


class IdentityMismatchError(IdentityError):
    """The configured signer is not the live connection's NKEY identity."""

    def __init__(
        self,
        signer_public_key: str,
        identity_user: str,
        *,
        signer_account: str | None = None,
        identity_account: str | None = None,
        credential_user: str | None = None,
    ) -> None:
        if credential_user is not None:
            message = (
                f"identity mismatch: the configured signer holds {signer_public_key} but its "
                f"credentials JWT names user {credential_user}"
            )
        elif signer_public_key != identity_user:
            message = (
                f"identity mismatch: the configured signer holds {signer_public_key} but the "
                f"connection's user NKEY is {identity_user}"
            )
        else:
            message = (
                f"identity mismatch: the configured signer belongs to account {signer_account} "
                f"but the connection is authenticated in account {identity_account}"
            )
        super().__init__(message)
        self.signer_public_key = signer_public_key
        self.identity_user = identity_user
        self.signer_account = signer_account
        self.identity_account = identity_account
        self.credential_user = credential_user


class InvalidAgentIdError(IdentityError):
    """``AgentId.parse`` / ``AgentId.new`` rejected the input (also for empty tokens)."""

    def __init__(self, message: str) -> None:
        super().__init__(f"invalid agent id: {message}")


class MalformedSenderHeaderError(IdentityError):
    """The ``Agent-Sender`` header failed the parser (spec: ``400``)."""

    def __init__(self, message: str) -> None:
        super().__init__(f"malformed Agent-Sender header: {message}")


class SenderSignatureRequiredError(IdentityError):
    """The endpoint declares ``min_sender_trust: signed`` and no signer is configured."""

    def __init__(self, subject: str) -> None:
        super().__init__(
            f"{subject} requires a signed Agent-Sender header (min_sender_trust=signed) but no "
            "identity.signer is configured"
        )
        self.subject = subject


class SenderVerificationError(IdentityError):
    """Host-internal: a classified request is refused.

    ``code`` is the wire status — ``401`` for a required-but-absent
    signature, a failing check (signature, ``sub``, stale ``ts``, replayed
    nonce, operator-attested disagreement) or a claimed / absent sender
    the acceptance hook refused; ``403`` for a verified sender the hook
    refused. ``description`` is the generic wire text (``"signature
    required"`` or ``"sender rejected"``); ``detail`` is receiver-side
    only and never sent on the wire.
    """

    def __init__(self, code: int, description: str, detail: str) -> None:
        super().__init__(f"sender verification failed ({code}): {detail}")
        self.code = code
        self.description = description
        self.detail = detail

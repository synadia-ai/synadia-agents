"""Pre-publish validation helpers per protocol §5.4.

§5.4 requires the caller to enforce the prompt endpoint's capability metadata
(``max_payload`` + ``attachments_ok``) BEFORE publishing. Failing locally
spares a round trip and the agent-side "reject with 400" path. Agents MAY
additionally enforce server-side — but a spec-compliant caller MUST fail
locally first.

These helpers are pure: they take the already-parsed capability fields and
the candidate payload shape, and raise a :class:`ValidationError` subclass
(``PromptEmptyError`` / ``AttachmentsNotSupportedError`` /
``PayloadTooLargeError``) on violation. The integration point lives in
:meth:`Agent.prompt`.
"""

from __future__ import annotations

from .errors import (
    AttachmentsNotSupportedError,
    PayloadTooLargeError,
    PromptEmptyError,
)


def assert_prompt_non_empty(prompt: str) -> None:
    """§5.1 requires ``prompt`` to be non-empty."""
    if prompt == "":
        raise PromptEmptyError()


def assert_attachments_allowed(
    has_attachments: bool,
    attachments_ok: bool | None,
) -> None:
    """Fail if attachments are present and the endpoint rejects them (§5.4).

    ``attachments_ok = None`` means the endpoint didn't declare the capability
    (e.g. a non-compliant agent). The strict §5.4 reading would be "assume
    false and fail" — but we follow the TS SDK's pragmatic path: no declared
    capability means no local assertion, and the agent decides server-side.
    """
    if has_attachments and attachments_ok is False:
        raise AttachmentsNotSupportedError()


def assert_within_max_payload(
    payload_size: int,
    max_payload_bytes: int | None,
    connection_max_payload: int | None = None,
) -> None:
    """Fail if the encoded payload is larger than the effective limit.

    Two caps bind a publish:

    1. ``max_payload_bytes`` — the agent's advertised limit (from its
       ``$SRV.INFO`` metadata, §2.1). What the *agent's* broker accepts.
    2. ``connection_max_payload`` — the *caller's* own
       ``nc.max_payload`` (from the local NATS server's INFO block).
       What the broker holding the caller's connection will publish at
       all. In multi-cluster / per-account deployments this can be
       smaller than the agent's advertised cap, in which case the
       caller's broker rejects the publish with
       ``MAX_PAYLOAD_VIOLATION`` before it ever reaches the agent.

    The effective cap is ``min`` of whichever are set. ``None`` for
    either means "not declared / not known" — when both are ``None`` we
    don't enforce locally and let the server decide (§5.4 last
    paragraph).
    """
    limits = [lim for lim in (max_payload_bytes, connection_max_payload) if lim is not None]
    if not limits:
        return
    effective = min(limits)
    if payload_size > effective:
        raise PayloadTooLargeError(limit=effective, actual=payload_size)

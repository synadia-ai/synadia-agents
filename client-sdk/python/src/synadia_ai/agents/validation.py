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
) -> None:
    """Fail if the encoded payload is larger than the endpoint's declared limit.

    ``max_payload_bytes = None`` means the endpoint didn't declare a limit
    (or the declared value was unparseable); in that case we don't enforce
    locally and let the server decide (§5.4 last paragraph).
    """
    if max_payload_bytes is not None and payload_size > max_payload_bytes:
        raise PayloadTooLargeError(limit=max_payload_bytes, actual=payload_size)

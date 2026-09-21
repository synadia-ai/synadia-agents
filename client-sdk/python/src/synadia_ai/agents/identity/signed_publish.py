"""Signing an arbitrary publish with a client's sender identity.

The core of :meth:`Agents.sign_sender` / :meth:`Agents.publish_signed` /
:meth:`Agents.request_signed`, shared with the signing handle a prompt
interceptor receives (:mod:`synadia_ai.agents.interceptor`), so a message
an interceptor publishes is signed exactly like one the application
publishes itself.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from ..errors import IdentityError, SenderSignatureRequiredError
from .options import Identity, plan_sender_header
from .sender_header import (
    AGENT_SENDER_HEADER,
    AgentSenderHeader,
    is_valid_sender_nonce,
    serialize_sender_header,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

#: JetStream de-duplication header; ``publish_signed`` sets it to the nonce.
NATS_MSG_ID_HEADER = "Nats-Msg-Id"


async def signed_sender_header(
    identity: Identity | None,
    nc: NATSClient,
    subject: str,
    payload: bytes,
    *,
    sub: str | None = None,
    nonce: str | None = None,
) -> AgentSenderHeader:
    """The signed ``Agent-Sender`` header for a publish of ``payload`` to ``subject``.

    ``nonce``, when given, is the header's nonce in place of a fresh one —
    for a message whose body carries its own id. It must match
    ``[A-Za-z0-9_-]{1,64}`` and be unique per signer: a receiver refuses a
    nonce it has already seen from the same user.

    Raises :class:`SenderSignatureRequiredError` when no signer is
    configured, :class:`IdentityError` for a malformed ``nonce``, else the
    ``self_id()`` error when the identity is unavailable.
    """
    if identity is None or identity.signer is None:
        raise SenderSignatureRequiredError(subject)
    if nonce is not None and not is_valid_sender_nonce(nonce):
        raise IdentityError("nonce must match [A-Za-z0-9_-]{1,64}")
    plan = await plan_sender_header(
        identity, nc, sub if sub is not None else subject, require_signed=True
    )
    if plan is None:  # unreachable with a signer; keeps the type checker honest
        raise SenderSignatureRequiredError(subject)
    return await plan.build(payload, nonce=nonce)


async def signed_publish_headers(
    identity: Identity | None,
    nc: NATSClient,
    subject: str,
    payload: bytes,
    *,
    sub: str | None = None,
    headers: Mapping[str, str] | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    """:func:`signed_sender_header` merged into ``headers``, with its ``Nats-Msg-Id``.

    ``Agent-Sender`` and ``Nats-Msg-Id`` win over entries of the same name.
    """
    header = await signed_sender_header(identity, nc, subject, payload, sub=sub, nonce=nonce)
    hdrs: dict[str, str] = dict(headers) if headers else {}
    hdrs[AGENT_SENDER_HEADER] = serialize_sender_header(header)
    if header.nonce is not None:
        hdrs[NATS_MSG_ID_HEADER] = header.nonce
    return hdrs


def to_bytes(payload: bytes | str) -> bytes:
    return payload.encode("utf-8") if isinstance(payload, str) else payload


__all__ = [
    "NATS_MSG_ID_HEADER",
    "signed_publish_headers",
    "signed_sender_header",
    "to_bytes",
]

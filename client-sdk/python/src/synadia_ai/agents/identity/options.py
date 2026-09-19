"""Caller identity options and per-request ``Agent-Sender`` planning.

Identity-bearing requests resolve the live connection identity every time.
This is deliberate: nats-py exposes no reconnect generation with which a
cached answer could be invalidated safely.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..errors import IdentityError, SenderSignatureRequiredError
from .agent_id import AgentId
from .self_id import (
    lookup_self_id,
    refresh_self_id,
    self_id,
    start_self_id_lookup,
)
from .sender_header import (
    AGENT_SENDER_HEADER,
    AgentSenderHeader,
    assert_valid_sender_name,
    build_claim_header,
    expected_sender_header_bytes,
    max_sender_header_bytes,
    serialize_sender_header,
    sign_sender_header,
)
from .signer import SenderSigner

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


@dataclass(frozen=True, slots=True)
class Identity:
    """Sender-identity options for :class:`~synadia_ai.agents.Agents` (``identity=``).

    ``signer`` signs ``Agent-Sender`` (without it the SDK can only send
    unsigned claims); ``name`` is the display name carried in the header
    (≤ 64 UTF-16 code units, no control characters — metadata only);
    ``send_unsigned_claim`` sends a claim (``v, account, user, name?``)
    when the identity is known but no signer is configured (default
    ``True``; note it discloses the caller's user NKEY to every receiver).
    """

    signer: SenderSigner | None = None
    name: str | None = None
    send_unsigned_claim: bool = True

    def __post_init__(self) -> None:
        if self.name is not None:
            assert_valid_sender_name(self.name)


@dataclass(frozen=True, slots=True, kw_only=True)
class SenderHeaderPlan:
    """What the SDK will attach to one request: known before signing, signed at publish time."""

    id: AgentId
    #: ``True`` → signed at :meth:`build`; ``False`` → an unsigned claim.
    signed: bool
    #: The subject that will be signed (``sub``).
    sub: str
    #: Exact framed wire size of the header :meth:`build` produces.
    wire_bytes: int
    identity: Identity

    async def build(self, payload: bytes, *, nonce: str | None = None) -> AgentSenderHeader:
        """Build the header over the exact payload bytes.

        A fresh ``ts`` each call, and a fresh nonce unless ``nonce`` names
        one. A signed record whose body carries its own id (an edge
        record's ``record_id``) passes it here, so the header's nonce,
        ``Nats-Msg-Id`` and the body agree.
        """
        signer = self.identity.signer
        if self.signed and signer is not None:
            return await sign_sender_header(
                signer=signer,
                id=self.id,
                sub=self.sub,
                payload=payload,
                name=self.identity.name,
                nonce=nonce,
            )
        return build_claim_header(id=self.id, name=self.identity.name)

    async def build_headers(self, payload: bytes, *, nonce: str | None = None) -> dict[str, str]:
        """The NATS headers dict for ``publish(headers=...)``."""
        header = await self.build(payload, nonce=nonce)
        return {AGENT_SENDER_HEADER: serialize_sender_header(header)}


async def self_id_for(identity: Identity | None, nc: NATSClient) -> AgentId:
    """``self_id()`` with live signer-to-connection binding when configured."""
    return await self_id(nc, signer=identity.signer if identity is not None else None)


async def refresh_self_id_for(identity: Identity | None, nc: NATSClient) -> AgentId:
    """``refresh_self_id()`` with the identity's signer."""
    return await refresh_self_id(nc, signer=identity.signer if identity is not None else None)


def kickoff_self_id(identity: Identity | None, nc: NATSClient) -> None:
    """Explicitly start an enabled identity lookup without waiting."""
    if identity is None or (identity.signer is None and not identity.send_unsigned_claim):
        return
    start_self_id_lookup(nc, signer=identity.signer)


def may_attach_header(identity: Identity | None, nc: NATSClient) -> bool:
    """Synchronous: could the next request carry a header?

    Governs the size bound applied before any async work. ``True`` with a
    signer, or with unsigned claims enabled. The answer cannot depend on a
    cached lookup because a reconnect may have changed the live identity.
    """
    if identity is None:
        return False
    if identity.signer is not None:
        return True
    return identity.send_unsigned_claim


def sender_header_bound(identity: Identity | None, nc: NATSClient, sub: str) -> int:
    """The sound upper bound of the header a request to ``sub`` may carry (0 when none may)."""
    if not may_attach_header(identity, nc):
        return 0
    assert identity is not None
    return max_sender_header_bytes(sub, identity.name)


async def resolve_identity_for_request(
    identity: Identity, nc: NATSClient, *, require_signed: bool
) -> AgentId | None:
    """Resolve one request against the live connection, without a persistent cache.

    Any failure with a configured signer propagates: signed identity never
    downgrades to an unsigned or header-less request. Signer-less unsigned
    claims remain opportunistic on permissive endpoints.
    """
    if identity.signer is not None:
        return await lookup_self_id(nc, signer=identity.signer)
    try:
        return await lookup_self_id(nc)
    except IdentityError:
        if require_signed:
            raise
        return None


async def plan_sender_header(
    identity: Identity | None, nc: NATSClient, sub: str, *, require_signed: bool
) -> SenderHeaderPlan | None:
    """Plan the header for a request to ``sub``; ``None`` when none will be sent.

    Raises :class:`SenderSignatureRequiredError` when ``require_signed``
    and no signer is configured (callers normally check that
    synchronously first).
    """
    signer = identity.signer if identity is not None else None
    if require_signed and signer is None:
        raise SenderSignatureRequiredError(sub)
    if identity is None:
        return None
    if signer is None and not identity.send_unsigned_claim:
        return None
    id = await resolve_identity_for_request(identity, nc, require_signed=require_signed)
    if id is None:
        return None
    signed = signer is not None
    return SenderHeaderPlan(
        id=id,
        signed=signed,
        sub=sub,
        wire_bytes=expected_sender_header_bytes(id=id, sub=sub, signed=signed, name=identity.name),
        identity=identity,
    )


__all__ = [
    "Identity",
    "SenderHeaderPlan",
    "kickoff_self_id",
    "may_attach_header",
    "plan_sender_header",
    "refresh_self_id_for",
    "resolve_identity_for_request",
    "self_id_for",
    "sender_header_bound",
]

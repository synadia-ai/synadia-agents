"""``Identity`` — the caller-side identity options — and the per-request header planning (internal).

The cost rule (plan §2.1a): a request awaits the identity lookup at most
once per connection. Afterwards a memoised answer is used; a failure
inside its 30 s TTL means "no header" (or the memoised error on a
``signed`` endpoint); an expired failure retries in the background while
the request proceeds without a header — except on a ``signed`` endpoint,
where the request would fail for certain, so it awaits the retry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..errors import IdentityMismatchError, NoIdentityError, SenderSignatureRequiredError
from .agent_id import AgentId
from .self_id import (
    peek_self_id,
    refresh_self_id,
    self_id,
    self_id_failure_expired,
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

    async def build(self, payload: bytes) -> AgentSenderHeader:
        """Build the header over the exact payload bytes — fresh ``ts`` / nonce each call."""
        signer = self.identity.signer
        if self.signed and signer is not None:
            return await sign_sender_header(
                signer=signer, id=self.id, sub=self.sub, payload=payload, name=self.identity.name
            )
        return build_claim_header(id=self.id, name=self.identity.name)

    async def build_headers(self, payload: bytes) -> dict[str, str]:
        """The NATS headers dict for ``publish(headers=...)``."""
        return {AGENT_SENDER_HEADER: serialize_sender_header(await self.build(payload))}


async def self_id_for(identity: Identity | None, nc: NATSClient) -> AgentId:
    """``self_id()`` with the identity's signer (JWT source + mismatch check)."""
    return await self_id(nc, signer=identity.signer if identity is not None else None)


async def refresh_self_id_for(identity: Identity | None, nc: NATSClient) -> AgentId:
    """``refresh_self_id()`` with the identity's signer."""
    return await refresh_self_id(nc, signer=identity.signer if identity is not None else None)


def kickoff_self_id(identity: Identity | None, nc: NATSClient) -> None:
    """Start the lookup without waiting (``discover()`` calls this)."""
    start_self_id_lookup(nc, signer=identity.signer if identity is not None else None)


def may_attach_header(identity: Identity | None, nc: NATSClient) -> bool:
    """Synchronous: could the next request carry a header?

    Governs the size bound applied before any async work. ``True`` with a
    signer, or with unsigned claims enabled unless the memo already holds
    a :class:`NoIdentityError`.
    """
    if identity is None:
        return False
    if identity.signer is not None:
        return True
    if not identity.send_unsigned_claim:
        return False
    return not isinstance(peek_self_id(nc), NoIdentityError)


def sender_header_bound(identity: Identity | None, nc: NATSClient, sub: str) -> int:
    """The sound upper bound of the header a request to ``sub`` may carry (0 when none may)."""
    if not may_attach_header(identity, nc):
        return 0
    assert identity is not None
    return max_sender_header_bytes(sub, identity.name)


async def resolve_identity_for_request(
    identity: Identity, nc: NATSClient, *, require_signed: bool
) -> AgentId | None:
    """The identity for one request per the cost rule, or ``None`` for a header-less request.

    :class:`IdentityMismatchError` always propagates; other identity
    errors propagate only when ``require_signed``.
    """
    settled = peek_self_id(nc)
    if isinstance(settled, AgentId):
        return settled
    if settled is not None:
        if isinstance(settled, IdentityMismatchError) or require_signed:
            raise settled
        return None
    if not require_signed and self_id_failure_expired(nc):
        kickoff_self_id(identity, nc)
        return None
    try:
        return await self_id(nc, signer=identity.signer)
    except IdentityMismatchError:
        raise
    except Exception:
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

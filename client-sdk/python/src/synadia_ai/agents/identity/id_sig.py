"""``id_sig`` — the registration signature that makes the registered agent ID verifiable.

Spec "Registration". Signed input (never sent; note the field order —
``user`` first, unlike ``AGENT-SENDER-V1``)::

    AGENT-ID-V1\\n{user_nkey}\\n{account}\\n{agent}\\n{owner}\\n{prompt_subject}\\n

A verifier rebuilds it from the ``user_nkey``, ``account``, ``agent``,
``owner`` metadata and the ``prompt`` endpoint's subject, all from one
``$SRV.INFO`` reply. Verification is synchronous.
"""

from __future__ import annotations

from collections.abc import Mapping

from ..errors import IdentityError
from ._nkeys import base64url_decode, base64url_encode, verify_with_public_key
from .agent_id import AgentId, assert_valid_user_key
from .signer import SenderSigner, maybe_await

AGENT_ID_SIGNED_INPUT_TAG = "AGENT-ID-V1"

#: The three metadata keys the host registers.
METADATA_USER_NKEY = "user_nkey"
METADATA_ACCOUNT = "account"
METADATA_ID_SIG = "id_sig"
IDENTITY_METADATA_KEYS: frozenset[str] = frozenset(
    {METADATA_USER_NKEY, METADATA_ACCOUNT, METADATA_ID_SIG}
)

_SIGNATURE_BYTES = 64


def build_agent_id_signed_input(
    *, user: str, account: str, agent: str, owner: str, prompt_subject: str
) -> bytes:
    """The exact bytes that are signed (never sent)."""
    return (
        f"{AGENT_ID_SIGNED_INPUT_TAG}\n{user}\n{account}\n{agent}\n{owner}\n{prompt_subject}\n"
    ).encode()


async def sign_agent_id(
    *, signer: SenderSigner, id: AgentId, agent: str, owner: str, prompt_subject: str
) -> str:
    """Produce the base64url ``id_sig`` value for the registration metadata."""
    data = build_agent_id_signed_input(
        user=id.user, account=id.account, agent=agent, owner=owner, prompt_subject=prompt_subject
    )
    return base64url_encode(await maybe_await(signer.sign(data)))


def verify_agent_id(metadata: Mapping[str, str], prompt_subject: str) -> bool:
    """Verify a service record's ``id_sig`` against its own ``prompt`` endpoint subject.

    ``False`` when any field is missing, the key or signature is
    malformed, or the signature does not verify.
    """
    user = metadata.get(METADATA_USER_NKEY)
    account = metadata.get(METADATA_ACCOUNT)
    agent = metadata.get("agent")
    owner = metadata.get("owner")
    id_sig = metadata.get(METADATA_ID_SIG)
    if user is None or account is None or agent is None or owner is None or id_sig is None:
        return False
    try:
        assert_valid_user_key(user)
        sig = base64url_decode(id_sig)
    except (IdentityError, ValueError):
        return False
    if len(sig) != _SIGNATURE_BYTES:
        return False
    data = build_agent_id_signed_input(
        user=user, account=account, agent=agent, owner=owner, prompt_subject=prompt_subject
    )
    return verify_with_public_key(user, data, sig)


__all__ = [
    "AGENT_ID_SIGNED_INPUT_TAG",
    "IDENTITY_METADATA_KEYS",
    "METADATA_ACCOUNT",
    "METADATA_ID_SIG",
    "METADATA_USER_NKEY",
    "build_agent_id_signed_input",
    "sign_agent_id",
    "verify_agent_id",
]

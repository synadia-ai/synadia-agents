"""The agent ID — ``{account}.{user}`` — as a validated ``str`` subclass.

Spec "Canonical text form". **This module is the only code that builds
or splits the text form**: host registration metadata, header parsing and
the reverse-lookup index all go through :meth:`AgentId.new` /
:meth:`AgentId.parse`.

- ``account`` — the account as ``$SYS.REQ.USER.INFO`` reports it: the
  account public NKEY (``A…``, 56 chars) on an operator-mode server, else
  a config-file account name matching ``[A-Za-z0-9_-]+`` or ``$G``.
- ``user`` — the user public NKEY (``U…``, 56 chars).

The regex is the shape check; the nkeys check (prefix byte + CRC) runs on
``user`` always and on ``account`` whenever it has the NKEY shape (starts
with ``A``, 56 characters — spec wording). Equality is string equality,
so ``==``, ``dict`` keys and ``set`` members work with no extra code.
"""

from __future__ import annotations

import re

import nkeys

from ..errors import InvalidAgentIdError
from ._nkeys import decode_public_key

#: Spec regex — the shape check for the canonical text form.
AGENT_ID_REGEX = re.compile(r"^(A[A-Z2-7]{55}|[A-Za-z0-9_-]+|\$G)\.U[A-Z2-7]{55}$")

_USER_KEY_REGEX = re.compile(r"^U[A-Z2-7]{55}$")
_ACCOUNT_NAME_REGEX = re.compile(r"^([A-Za-z0-9_-]+|\$G)$")
_NKEY_PUBLIC_LENGTH = 56

#: Size-bound allowance for ``account`` in UTF-8 bytes (56 for an NKEY);
#: longer config-mode names are unrepresentable (``NoIdentityError``).
ACCOUNT_LENGTH_ALLOWANCE_BYTES = 64


def is_user_key_shaped(user: str) -> bool:
    """True iff ``user`` has the shape of a user public NKEY (``U…``, 56 base32 chars)."""
    return _USER_KEY_REGEX.match(user) is not None


def is_account_key_shaped(account: str) -> bool:
    """True iff ``account`` has the shape of an account public NKEY (``A…``, 56 chars)."""
    return len(account) == _NKEY_PUBLIC_LENGTH and account.startswith("A")


def _assert_valid_nkey(kind: str, key: str, prefix_byte: int) -> None:
    try:
        decode_public_key(key, prefix_byte)
    except ValueError as exc:
        raise InvalidAgentIdError(f"{kind} key fails the nkeys check ({exc})") from exc


def assert_valid_user_key(user: str) -> None:
    """Validate ``user`` as a user public NKEY (shape + nkeys prefix/CRC)."""
    if not user:
        raise InvalidAgentIdError("empty user token")
    if not is_user_key_shaped(user):
        raise InvalidAgentIdError("user token is not a user public NKEY (U + 55 base32 chars)")
    _assert_valid_nkey("user", user, nkeys.PREFIX_BYTE_USER)


def assert_valid_account(account: str) -> None:
    """Validate ``account`` as an account public NKEY or a representable config-mode name."""
    if not account:
        raise InvalidAgentIdError("empty account token")
    if is_account_key_shaped(account):
        _assert_valid_nkey("account", account, nkeys.PREFIX_BYTE_ACCOUNT)
        return
    if _ACCOUNT_NAME_REGEX.match(account) is None:
        raise InvalidAgentIdError(
            "account token is neither an account public NKEY nor a subject-safe name "
            "([A-Za-z0-9_-]+ or $G)"
        )


class AgentId(str):
    """A validated ``{account}.{user}`` agent ID (a ``str``; compare with ``==``).

    Validation lives in ``__new__`` so no unvalidated instance can exist:
    ``AgentId(text)`` is :meth:`parse`. Use :meth:`new` to build one from
    the two tokens.
    """

    __slots__ = ()

    def __new__(cls, text: str) -> AgentId:
        if not text:
            raise InvalidAgentIdError("empty string")
        if AGENT_ID_REGEX.match(text) is None:
            raise InvalidAgentIdError("expected {account}.{user} with a U… user public NKEY")
        account, _, user = text.partition(".")
        assert_valid_account(account)
        assert_valid_user_key(user)
        return super().__new__(cls, text)

    @classmethod
    def new(cls, account: str, user: str) -> AgentId:
        """The only constructor from tokens. Validates both and fails loud otherwise.

        There is no zero agent ID: empty tokens are rejected.
        """
        assert_valid_account(account)
        assert_valid_user_key(user)
        return super().__new__(cls, f"{account}.{user}")

    @classmethod
    def parse(cls, text: str) -> AgentId:
        """The only way from text to an ID. Accepts the canonical form and nothing else."""
        return cls(text)

    @property
    def account(self) -> str:
        """The ``account`` token."""
        return self.partition(".")[0]

    @property
    def user(self) -> str:
        """The ``user`` token (the user public NKEY)."""
        return self.partition(".")[2]

    def __repr__(self) -> str:
        return f"AgentId({str.__repr__(self)})"


__all__ = [
    "ACCOUNT_LENGTH_ALLOWANCE_BYTES",
    "AGENT_ID_REGEX",
    "AgentId",
    "assert_valid_account",
    "assert_valid_user_key",
    "is_account_key_shaped",
    "is_user_key_shaped",
]

"""Signing capability for the sender-identity extension.

Both SDKs take a pre-opened connection and never see its credentials, so
the seed is handed in explicitly through a :class:`SenderSigner`. The
built-in implementation wraps an ``nkeys`` user key pair; users with an
HSM / KMS implement the protocol themselves (``sign`` may be async).

Key hygiene: the key pair lives in a private attribute, is redacted from
``repr()`` / ``str()``, the seed buffer is zeroed once the public key is
cached (``nkeys.from_seed`` keeps a reference to the buffer it was given
and re-decodes it only for ``public_key``, which this class caches
first), and :meth:`NkeySigner.wipe` clears the pair. Error messages never
include input text — public keys and line numbers only.

No ``@nats-io/jwt`` equivalent: creds files and JWT payloads are parsed by
hand (the ``-----BEGIN NATS USER JWT-----`` / ``-----BEGIN USER NKEY
SEED-----`` blocks, and a base64url JSON payload decode — no signature
check, the server already authenticated the JWT).
"""

from __future__ import annotations

import base64
import binascii
import inspect
import json
import re
from collections.abc import Awaitable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, TypeVar

import nkeys

from ..context import expand_user, read_context_file
from ..errors import IdentityError, IdentityMismatchError, IdentityUnavailableError
from ._nkeys import base64url_decode
from .agent_id import AgentId

T = TypeVar("T")

_USER_SEED_REGEX = re.compile(r"^SU[A-Z2-7]{56}$")
_JWT_REGEX = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$")
_BEGIN_JWT_REGEX = re.compile(r"^-+BEGIN NATS USER JWT-+$")
_BEGIN_SEED_REGEX = re.compile(r"^-+BEGIN USER NKEY SEED-+$")
_JWT_PARTS = 3
_CRC_BYTES = 2


class SenderSigner(Protocol):
    """Something that can sign with the connection's user NKEY seed.

    ``sign`` may return the signature directly or an awaitable of it
    (HSM / KMS signers). ``jwt`` is the user JWT when the signer came from
    a credentials file — ``self_id()`` reads the agent ID from it (no
    network, not spoofable by peers); ``None`` otherwise.
    """

    @property
    def public_key(self) -> str:
        """The user public NKEY (``U…``) this signer signs for."""
        ...

    @property
    def jwt(self) -> str | None:
        """The user JWT, when the signer came from a credentials file."""
        ...

    def sign(self, data: bytes) -> bytes | Awaitable[bytes]:
        """ed25519 signature over ``data``."""
        ...


async def maybe_await(value: T | Awaitable[T]) -> T:
    """Await ``value`` when it is awaitable (an async ``sign`` / hook), else return it."""
    if inspect.isawaitable(value):
        return await value
    return value


class NkeySigner:
    """The built-in :class:`SenderSigner` over an ``nkeys`` user key pair."""

    __slots__ = ("_jwt", "_kp", "_public_key")

    def __init__(self, kp: nkeys.KeyPair, jwt: str | None) -> None:
        self._kp: nkeys.KeyPair | None = kp
        # Cache before the seed buffer is zeroed: `public_key` re-decodes
        # the seed on first access.
        self._public_key: str = kp.public_key.decode("ascii")
        self._jwt = jwt

    @property
    def public_key(self) -> str:
        return self._public_key

    @property
    def jwt(self) -> str | None:
        return self._jwt

    def sign(self, data: bytes) -> bytes:
        if self._kp is None:
            raise IdentityError("signer has been wiped")
        return bytes(self._kp.sign(data))

    def wipe(self) -> None:
        """Clear the key material; later :meth:`sign` calls fail."""
        if self._kp is not None:
            self._kp.wipe()
            self._kp = None

    def __repr__(self) -> str:
        return f"SenderSigner({self._public_key})"

    __str__ = __repr__


def signer_from_seed(seed: str | bytes, jwt: str | None = None) -> NkeySigner:
    """Build a signer from a user seed (``SU…``), given as text or bytes.

    Surrounding whitespace (a trailing newline from a seed file) is
    ignored, and a ``-----BEGIN USER NKEY SEED-----`` block is accepted
    too. The seed is not retained; the message of a rejection never
    includes it.
    """
    text = seed if isinstance(seed, str) else seed.decode("utf-8", errors="replace")
    line = (
        _extract_block(text, _BEGIN_SEED_REGEX, "USER NKEY SEED")
        if "BEGIN" in text
        else text.strip()
    )
    if _USER_SEED_REGEX.match(line) is None:
        raise IdentityError("invalid nkey seed: expected a user seed (SU + 56 base32 characters)")
    buf = bytearray(line.encode("ascii"))
    try:
        raw = base64.b32decode(bytes(buf) + b"=" * (-len(buf) % 8))
        if nkeys.crc16_checksum(raw[:-_CRC_BYTES]) != raw[-_CRC_BYTES:]:
            raise IdentityError("invalid nkey seed (CRC check failed)")
        kp = nkeys.from_seed(buf)
        signer = NkeySigner(kp, jwt)
    except (nkeys.NkeysError, binascii.Error, ValueError) as exc:
        raise IdentityError(f"invalid nkey seed ({type(exc).__name__})") from exc
    finally:
        # `from_seed` keeps `buf` by reference; the public key is cached
        # above, and signing needs only the derived key — zero the text.
        for i in range(len(buf)):
            buf[i] = 0
    if not signer.public_key.startswith("U"):
        signer.wipe()
        raise IdentityError(
            f"seed is not a user seed (derives {signer.public_key[:1]}… public key)"
        )
    return signer


@dataclass(frozen=True, slots=True)
class ParsedCreds:
    """The two blocks of a credentials file."""

    jwt: str
    seed: str


def parse_creds(text: str) -> ParsedCreds:
    """Hand-rolled ``.creds`` parser.

    The line after ``-----BEGIN NATS USER JWT-----`` is the JWT, the line
    after ``-----BEGIN USER NKEY SEED-----`` is the seed. Error messages
    carry line numbers, never content.
    """
    jwt = _extract_block(text, _BEGIN_JWT_REGEX, "NATS USER JWT")
    if _JWT_REGEX.match(jwt) is None:
        raise IdentityError("creds: the user JWT block is not a JWT")
    seed = _extract_block(text, _BEGIN_SEED_REGEX, "USER NKEY SEED")
    return ParsedCreds(jwt=jwt, seed=seed)


def _extract_block(text: str, begin: re.Pattern[str], label: str) -> str:
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if begin.match(line.strip()) is None:
            continue
        for candidate in (ln.strip() for ln in lines[i + 1 :]):
            if not candidate:
                continue
            if candidate.startswith("-"):
                raise IdentityError(f"creds: empty {label} block at line {i + 1}")
            return candidate
        raise IdentityError(f"creds: {label} block at line {i + 1} has no content")
    raise IdentityError(f"creds: no -----BEGIN {label}----- block found")


def decode_jwt_payload(jwt: str) -> dict[str, Any]:
    """Decode the payload (second part) of a JWT without verifying it."""
    parts = jwt.split(".")
    if len(parts) != _JWT_PARTS:
        raise IdentityError("JWT does not have three parts")
    try:
        payload = json.loads(base64url_decode(parts[1].rstrip("=")).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise IdentityError("JWT payload is not base64url-encoded JSON") from exc
    if not isinstance(payload, dict):
        raise IdentityError("JWT payload is not a JSON object")
    return payload


def identity_from_jwt(jwt: str) -> AgentId:
    """The agent ID a user JWT carries.

    ``sub`` is the user NKEY; the account is ``nats.issuer_account`` when
    a signing key issued the JWT, else ``iss``.
    """
    payload = decode_jwt_payload(jwt)
    sub = payload.get("sub")
    iss = payload.get("iss")
    nats_claims = payload.get("nats")
    issuer_account = nats_claims.get("issuer_account") if isinstance(nats_claims, dict) else None
    account = issuer_account if isinstance(issuer_account, str) and issuer_account else iss
    if not isinstance(sub, str) or not isinstance(account, str):
        raise IdentityUnavailableError("credentials JWT lacks a string `sub` or `iss`")
    try:
        return AgentId.new(account, sub)
    except IdentityError as exc:
        raise IdentityUnavailableError(
            f"credentials JWT does not carry a usable (account, user) pair: {exc}"
        ) from exc


def signer_from_creds(creds_text: str) -> NkeySigner:
    """Build a signer from credentials-file text.

    The signer carries the user JWT so ``self_id()`` can read the identity
    without asking the server. A seed that does not belong to the JWT's
    ``sub`` is rejected with :class:`IdentityMismatchError` (public keys
    only in the message).
    """
    parsed = parse_creds(creds_text)
    signer = signer_from_seed(parsed.seed, parsed.jwt)
    jwt_user = identity_from_jwt(parsed.jwt).user
    if jwt_user != signer.public_key:
        signer.wipe()
        raise IdentityMismatchError(signer.public_key, jwt_user)
    return signer


def signer_from_creds_file(path: str | Path) -> NkeySigner:
    """:func:`signer_from_creds` over a file path (``~/`` expanded)."""
    resolved = Path(expand_user(str(path)))
    try:
        text = resolved.read_text(encoding="utf-8")
    except OSError as exc:
        raise IdentityError(f"failed to read creds file {resolved}: {exc.strerror}") from exc
    return signer_from_creds(text)


def signer_from_context(selector: str) -> NkeySigner:
    """Build a signer from a ``nats`` CLI context (``"current"`` resolves the selected one).

    ``creds`` → :func:`signer_from_creds_file`; else ``nkey`` (a seed file)
    → :func:`signer_from_seed`; else inline ``user_seed`` (+ ``user_jwt``).
    Reuses the context *reader*, not the connection-option builder.
    """
    ctx = read_context_file(selector)
    creds = _optional_str(ctx.fields.get("creds"))
    nkey = _optional_str(ctx.fields.get("nkey"))
    user_seed = _optional_str(ctx.fields.get("user_seed"))
    user_jwt = _optional_str(ctx.fields.get("user_jwt"))
    if creds is not None:
        return signer_from_creds_file(creds)
    if nkey is not None:
        seed_path = Path(expand_user(nkey))
        try:
            return signer_from_seed(seed_path.read_bytes())
        except OSError as exc:
            raise IdentityError(
                f"failed to read nkey seed file {seed_path}: {exc.strerror}"
            ) from exc
    if user_seed is not None:
        signer = signer_from_seed(user_seed, user_jwt)
        if user_jwt is not None:
            jwt_user = identity_from_jwt(user_jwt).user
            if jwt_user != signer.public_key:
                signer.wipe()
                raise IdentityMismatchError(signer.public_key, jwt_user)
        return signer
    raise IdentityError(
        f"NATS context {ctx.name!r} has no creds, nkey, or user_seed — nothing to sign "
        "Agent-Sender with"
    )


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


__all__ = [
    "NkeySigner",
    "ParsedCreds",
    "SenderSigner",
    "decode_jwt_payload",
    "identity_from_jwt",
    "maybe_await",
    "parse_creds",
    "signer_from_context",
    "signer_from_creds",
    "signer_from_creds_file",
    "signer_from_seed",
]

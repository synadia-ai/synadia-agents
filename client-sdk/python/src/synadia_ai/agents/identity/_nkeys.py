"""Low-level crypto helpers for the sender-identity extension (internal).

Validating base64url (no padding), SHA-256, the hand-rolled public-NKEY
decode (the ``nkeys`` library has no public-key verify — plan §2.9), and
ed25519 verification through PyNaCl with a small LRU of decoded keys.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
from collections import OrderedDict

import nacl.exceptions
import nacl.signing
import nkeys

#: Lowercase hex SHA-256 of zero bytes — what an empty payload hashes to.
SHA256_EMPTY_HEX = hashlib.sha256(b"").hexdigest()

_B64URL_ALPHABET = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
_B64URL_TO_STD = str.maketrans("-_", "+/")
_B64_GROUP = 4
_B64_INVALID_REMAINDER = 1
_PUBLIC_KEY_LENGTH = 56
_PUBLIC_KEY_RAW_LENGTH = 35  # prefix byte + 32 key bytes + 2 CRC bytes
_CRC_BYTES = 2
_KEY_CACHE_MAX = 256


def base64url_encode(data: bytes) -> str:
    """RFC 4648 §5 base64url, no padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def base64url_decode(text: str) -> bytes:
    """Validating base64url decode.

    Alphabet ``[A-Za-z0-9_-]`` only, no padding characters, a length that
    is not ≡ 1 (mod 4). Raises :class:`ValueError` on anything else.
    """
    if any(c not in _B64URL_ALPHABET for c in text):
        raise ValueError("invalid base64url character")
    if len(text) % _B64_GROUP == _B64_INVALID_REMAINDER:
        raise ValueError("invalid base64url length")
    padded = text.translate(_B64URL_TO_STD) + "=" * (-len(text) % _B64_GROUP)
    try:
        return base64.b64decode(padded, validate=True)
    except binascii.Error as exc:
        raise ValueError(f"invalid base64url: {exc}") from exc


def sha256_hex(data: bytes) -> str:
    """Lowercase hex SHA-256 of ``data`` — the payload line of the signed inputs."""
    return hashlib.sha256(data).hexdigest()


def decode_public_key(key: str, prefix_byte: int) -> bytes:
    """Decode a public NKEY (``U…`` / ``A…``) to its 32 raw key bytes.

    Checks the base32 shape, the prefix byte and the CRC-16 (little-endian,
    as ``nkeys`` encodes it). Raises :class:`ValueError` on any failure;
    the message never echoes the key.
    """
    if len(key) != _PUBLIC_KEY_LENGTH:
        raise ValueError("public key must be 56 characters")
    try:
        raw = base64.b32decode(key + "=" * (-len(key) % 8))
    except (binascii.Error, ValueError) as exc:
        raise ValueError("public key is not base32") from exc
    if len(raw) != _PUBLIC_KEY_RAW_LENGTH:
        raise ValueError("public key decodes to the wrong length")
    if raw[0] != prefix_byte:
        raise ValueError("public key has the wrong prefix byte")
    if nkeys.crc16_checksum(raw[:-_CRC_BYTES]) != raw[-_CRC_BYTES:]:
        raise ValueError("public key fails the CRC check")
    return raw[1:-_CRC_BYTES]


def encode_public_key(raw: bytes, prefix_byte: int) -> str:
    """Encode 32 raw key bytes as a public NKEY with ``prefix_byte`` (inverse of decode)."""
    body = bytes([prefix_byte]) + raw
    return base64.b32encode(body + nkeys.crc16_checksum(body)).decode("ascii").rstrip("=")


# Decoded verify keys, small LRU: verifying a header is one ed25519 check,
# but the base32 + CRC decode would otherwise run each time; a few hundred
# keys cover any realistic set of senders. Process-wide and without a TTL:
# it holds public keys only (~32 bytes each, at most 256 entries ≈ 8 KiB),
# is untouched by connection teardown, and a key that left a NATS account
# simply stays decoded until evicted — no security impact, since the cache
# never decides *whether* a key is trusted, only how it is decoded.
_key_cache: OrderedDict[str, nacl.signing.VerifyKey] = OrderedDict()


def _verify_key(public_key: str) -> nacl.signing.VerifyKey:
    cached = _key_cache.get(public_key)
    if cached is not None:
        _key_cache.move_to_end(public_key)
        return cached
    prefix = nkeys.PREFIX_BYTE_ACCOUNT if public_key.startswith("A") else nkeys.PREFIX_BYTE_USER
    vk = nacl.signing.VerifyKey(decode_public_key(public_key, prefix))
    _key_cache[public_key] = vk
    if len(_key_cache) > _KEY_CACHE_MAX:
        _key_cache.popitem(last=False)
    return vk


def verify_with_public_key(public_key: str, data: bytes, sig: bytes) -> bool:
    """ed25519 verification against a public NKEY (``U…`` / ``A…``).

    Returns ``False`` for an undecodable key rather than raising — callers
    validate the key shape before this point, so a decode failure is a
    malformed input, not a verifier fault. A ``BadSignatureError`` is
    ``False`` as well. Anything else PyNaCl raises propagates: a verifier
    fault must surface as an error (→ ``500`` at a receiver), never as a
    silent ``401``.
    """
    try:
        vk = _verify_key(public_key)
    except (ValueError, nacl.exceptions.ValueError, nacl.exceptions.TypeError):
        return False
    try:
        vk.verify(data, sig)
    except nacl.exceptions.BadSignatureError:
        return False
    return True


__all__ = [
    "SHA256_EMPTY_HEX",
    "base64url_decode",
    "base64url_encode",
    "decode_public_key",
    "encode_public_key",
    "sha256_hex",
    "verify_with_public_key",
]

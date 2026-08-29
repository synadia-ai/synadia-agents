"""The ``Agent-Sender`` header: the one shared codec (build, serialise, parse, sign, verify).

Used by both the caller package and the host package::

    Agent-Sender: {"v":1,"account":"A…","user":"U…","name":"…","sub":"…",
                   "ts":"…","nonce":"…","sig":"…"}

Serialisation is canonical and byte-equal across languages: fields in
the order ``v, account, user, name?, sub?, ts?, nonce?, sig?`` (absent
ones omitted), compact separators, non-ASCII raw, ``v`` the integer 1. A
parsed header is never re-serialised; the signed input is rebuilt from
fields.

Signed input (never sent)::

    AGENT-SENDER-V1\\n{account}\\n{user}\\n{subject}\\n{ts}\\n{nonce}\\n{sha256(payload) hex}\\n

The parser is hardened per the plan (§2.2): a violation is
:class:`MalformedSenderHeaderError` (→ ``400`` at the receiver); an
unknown ``v`` makes the header count as absent (``None``).
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal, Protocol, TypeAlias

from .._inbox import _nuid
from ..errors import (
    IdentityError,
    InvalidAgentIdError,
    MalformedSenderHeaderError,
    SenderVerificationError,
)
from ._nkeys import base64url_decode, base64url_encode, sha256_hex, verify_with_public_key
from .agent_id import ACCOUNT_LENGTH_ALLOWANCE_BYTES, AgentId
from .format import format_sender
from .signer import SenderSigner, maybe_await

if TYPE_CHECKING:
    from ..discovery import AgentInfo

#: The header name — matched case-sensitively.
AGENT_SENDER_HEADER = "Agent-Sender"
#: The header format version this SDK implements.
AGENT_SENDER_VERSION = 1
#: First line of the signed input.
AGENT_SENDER_SIGNED_INPUT_TAG = "AGENT-SENDER-V1"
#: Header value length cap applied before JSON parsing.
MAX_SENDER_HEADER_VALUE_BYTES = 2048
#: Display-name cap (UTF-16 code units, as the TS SDK counts) — an SDK rule, not a wire rule.
MAX_SENDER_NAME_LENGTH = 64
#: Default replay window / ``ts`` skew (spec: 30 s).
DEFAULT_REPLAY_WINDOW_S = 30.0
#: ``NATS/1.0\\r\\nAgent-Sender: `` + ``\\r\\n\\r\\n`` — the framing the server
#: counts against ``max_payload``.
SENDER_HEADER_FRAMING_BYTES = 28
#: Generic wire description for every refusal except a missing required signature.
SENDER_REJECTED_DESCRIPTION = "sender rejected"
#: Wire description when ``min_sender_trust: signed`` and the request is not verified.
SIGNATURE_REQUIRED_DESCRIPTION = "signature required"

VerifyMode = Literal["live", "stored"]

_TS_REGEX = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
_NONCE_REGEX = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Subject shape: non-empty tokens separated by `.`, no whitespace / control chars.
_SUBJECT_REGEX = re.compile(r"^[^\s.\x00-\x1f\x7f]+(\.[^\s.\x00-\x1f\x7f]+)*$")
_SIGNATURE_BYTES = 64
_SIGNATURE_B64URL_LENGTH = 86
_TS_LENGTH = 20  # YYYY-MM-DDTHH:MM:SSZ
_TS_SECONDS_END = 19
_NUID_LENGTH = 22
_MAX_NONCE_LENGTH = 64
_USER_KEY_LENGTH = 56
_C0_MAX = 0x1F
_DEL = 0x7F
_C1_MAX = 0x9F
_LINE_SEPARATOR = 0x2028
_PARAGRAPH_SEPARATOR = 0x2029
_SURROGATE_MIN = 0xD800
_SURROGATE_MAX = 0xDFFF
_BMP_MAX = 0xFFFF


@dataclass(frozen=True, slots=True, kw_only=True)
class AgentSenderHeader:
    """A parsed (or built) ``Agent-Sender`` header. Only the known fields."""

    v: Literal[1] = 1
    account: str
    user: str
    name: str | None = None
    sub: str | None = None
    ts: str | None = None
    nonce: str | None = None
    sig: str | None = None


@dataclass(frozen=True, slots=True)
class SenderClaim:
    """The ``(account, user)`` pair of an unsigned claim — deliberately not an :class:`AgentId`."""

    account: str
    user: str


@dataclass(frozen=True, slots=True, kw_only=True)
class VerifiedSender:
    """A sender whose signature verified: ``user`` is proven, ``account`` is the signed claim."""

    id: AgentId
    header: AgentSenderHeader
    name: str | None = None
    #: ``True`` only when the deployment declared the endpoint closed
    #: (operator-attested mode, host package) and the server stamp agreed
    #: with the signed ``account``. Always ``False`` from this package.
    account_attested: bool = False
    trust: Literal["verified"] = field(default="verified", init=False)
    _resolver: Callable[[], Awaitable[AgentInfo | None]] | None = field(
        default=None, repr=False, compare=False
    )

    async def resolve(self) -> AgentInfo | None:
        """Reverse lookup bound by the host; ``None`` when unbound or not found."""
        if self._resolver is None:
            return None
        return await self._resolver()

    def __str__(self) -> str:
        return format_sender(self)


@dataclass(frozen=True, slots=True, kw_only=True)
class ClaimedSender:
    """An unsigned claim — display-grade. Deliberately has no ``id`` attribute."""

    claim: SenderClaim
    header: AgentSenderHeader
    name: str | None = None
    trust: Literal["claimed"] = field(default="claimed", init=False)

    def __str__(self) -> str:
        return format_sender(self)


SenderInfo: TypeAlias = VerifiedSender | ClaimedSender


# ---------------------------------------------------------------------------
# Display name validation (shared by the option validator and the parser).
# ---------------------------------------------------------------------------


def assert_valid_sender_name(name: str) -> None:
    """``name`` rules: ≤ 64 UTF-16 code units, no C0/C1/DEL/U+2028/U+2029, no lone surrogates.

    Raises :class:`IdentityError`; the message never includes the name.
    The length is counted in UTF-16 code units (an emoji counts 2) so the
    cap is the same one the TypeScript SDK applies.
    """
    units = sum(2 if ord(c) > _BMP_MAX else 1 for c in name)
    if units > MAX_SENDER_NAME_LENGTH:
        raise IdentityError(f"identity.name exceeds {MAX_SENDER_NAME_LENGTH} UTF-16 code units")
    for ch in name:
        c = ord(ch)
        if c <= _C0_MAX or _DEL <= c <= _C1_MAX or c in (_LINE_SEPARATOR, _PARAGRAPH_SEPARATOR):
            raise IdentityError("identity.name contains a control character")
        if _SURROGATE_MIN <= c <= _SURROGATE_MAX:
            raise IdentityError("identity.name contains a lone surrogate")


def _is_valid_sender_name(name: str) -> bool:
    try:
        assert_valid_sender_name(name)
    except IdentityError:
        return False
    return True


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------


def serialize_sender_header(h: AgentSenderHeader) -> str:
    """Canonical single-line JSON (field order fixed, absent fields omitted)."""
    o: dict[str, object] = {"v": AGENT_SENDER_VERSION, "account": h.account, "user": h.user}
    if h.name is not None:
        o["name"] = h.name
    if h.sub is not None:
        o["sub"] = h.sub
    if h.ts is not None:
        o["ts"] = h.ts
    if h.nonce is not None:
        o["nonce"] = h.nonce
    if h.sig is not None:
        o["sig"] = h.sig
    return json.dumps(o, separators=(",", ":"), ensure_ascii=False)


def encoded_header_length(value: str) -> int:
    """Wire length of the header including NATS header framing (28 bytes + the value)."""
    return SENDER_HEADER_FRAMING_BYTES + len(value.encode("utf-8"))


def max_sender_header_bytes(subject: str, name: str | None = None) -> int:
    """Sound upper bound on the framed size of any header this SDK would send.

    Real lengths for the subject and the name, the fixed field widths
    (``user`` 56, ``ts`` 20, ``nonce`` ≤ 64, ``sig`` 86), a 64-byte
    ``account`` allowance, JSON overhead, and the 28 framing bytes.
    """
    template = AgentSenderHeader(
        account="A" * ACCOUNT_LENGTH_ALLOWANCE_BYTES,
        user="U" * _USER_KEY_LENGTH,
        name=name,
        sub=subject,
        ts="T" * _TS_LENGTH,
        nonce="N" * _MAX_NONCE_LENGTH,
        sig="S" * _SIGNATURE_B64URL_LENGTH,
    )
    return encoded_header_length(serialize_sender_header(template))


def expected_sender_header_bytes(
    *, id: AgentId, sub: str, signed: bool, name: str | None = None
) -> int:
    """Exact framed size of the header the SDK will send for a known identity.

    Every field this SDK emits has a fixed width except ``account``,
    ``user``, ``name`` and ``sub``, which are known before signing.
    """
    header = AgentSenderHeader(
        account=id.account,
        user=id.user,
        name=name,
        sub=sub if signed else None,
        ts="T" * _TS_LENGTH if signed else None,
        nonce="N" * _NUID_LENGTH if signed else None,
        sig="S" * _SIGNATURE_B64URL_LENGTH if signed else None,
    )
    return encoded_header_length(serialize_sender_header(header))


# ---------------------------------------------------------------------------
# Parsing (hardened)
# ---------------------------------------------------------------------------


def read_sender_header_value(headers: Mapping[str, object] | None) -> str | None:
    """Read the raw ``Agent-Sender`` value from message headers.

    Exact-case match; ``None`` when absent (including a differently-cased
    name). nats-py hands a receiver one value per header name; a raw
    multi-value list (``list[str]``) with more than one entry is
    :class:`MalformedSenderHeaderError`, as the spec's "one header" rule
    requires.
    """
    if not headers:
        return None
    value = headers.get(AGENT_SENDER_HEADER)
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list | tuple):
        if len(value) == 0:
            return None
        if len(value) > 1:
            raise MalformedSenderHeaderError("more than one Agent-Sender value")
        first = value[0]
        if isinstance(first, str):
            return first
    raise MalformedSenderHeaderError("header value is not a string")


def parse_sender_header(value: str) -> AgentSenderHeader | None:  # noqa: PLR0912, PLR0915
    """Parse a header value.

    Returns ``None`` for a well-formed header with an unknown ``v`` (the
    receiver treats it as absent). Raises
    :class:`MalformedSenderHeaderError` for everything the spec calls
    malformed and for the plan's hardening rules (§2.2). ``v`` is checked
    by hand — a JSON number, not ``"1"`` or ``true``.
    """
    if len(value.encode("utf-8")) > MAX_SENDER_HEADER_VALUE_BYTES:
        raise MalformedSenderHeaderError(f"value exceeds {MAX_SENDER_HEADER_VALUE_BYTES} bytes")
    try:
        parsed = json.loads(value)
    except ValueError as exc:
        raise MalformedSenderHeaderError("not valid JSON") from exc
    if not isinstance(parsed, dict):
        raise MalformedSenderHeaderError("not a JSON object")
    o: dict[str, object] = parsed

    v = o.get("v")
    if isinstance(v, bool) or not isinstance(v, int | float):
        raise MalformedSenderHeaderError("`v` must be a JSON number")
    if v != AGENT_SENDER_VERSION:
        return None

    account = o.get("account")
    user = o.get("user")
    if not isinstance(account, str) or not isinstance(user, str):
        raise MalformedSenderHeaderError("`account` and `user` must be strings")
    try:
        AgentId.new(account, user)
    except InvalidAgentIdError as exc:
        raise MalformedSenderHeaderError(str(exc)) from exc

    name: str | None = None
    if "name" in o:
        raw_name = o["name"]
        if not isinstance(raw_name, str) or not _is_valid_sender_name(raw_name):
            raise MalformedSenderHeaderError("`name` is not a valid display name")
        name = raw_name

    sub: str | None = None
    if "sub" in o:
        raw_sub = o["sub"]
        if not isinstance(raw_sub, str) or _SUBJECT_REGEX.match(raw_sub) is None:
            raise MalformedSenderHeaderError("`sub` is not a NATS subject")
        sub = raw_sub

    ts: str | None = None
    if "ts" in o:
        raw_ts = o["ts"]
        if not isinstance(raw_ts, str) or _TS_REGEX.match(raw_ts) is None:
            raise MalformedSenderHeaderError("`ts` is not an RFC 3339 UTC timestamp")
        try:
            parse_sender_timestamp(raw_ts)
        except ValueError as exc:
            raise MalformedSenderHeaderError("`ts` is not an RFC 3339 UTC timestamp") from exc
        ts = raw_ts

    nonce: str | None = None
    if "nonce" in o:
        raw_nonce = o["nonce"]
        if not isinstance(raw_nonce, str) or _NONCE_REGEX.match(raw_nonce) is None:
            raise MalformedSenderHeaderError("`nonce` must match [A-Za-z0-9_-]{1,64}")
        nonce = raw_nonce

    sig: str | None = None
    if "sig" in o:
        raw_sig = o["sig"]
        if not isinstance(raw_sig, str):
            raise MalformedSenderHeaderError("`sig` must be a string")
        try:
            sig_bytes = base64url_decode(raw_sig)
        except ValueError as exc:
            raise MalformedSenderHeaderError("`sig` is not base64url") from exc
        if len(sig_bytes) != _SIGNATURE_BYTES:
            raise MalformedSenderHeaderError("`sig` must decode to 64 bytes")
        if sub is None or ts is None or nonce is None:
            raise MalformedSenderHeaderError("`sig` requires `sub`, `ts` and `nonce`")
        sig = raw_sig

    return AgentSenderHeader(
        account=account, user=user, name=name, sub=sub, ts=ts, nonce=nonce, sig=sig
    )


# ---------------------------------------------------------------------------
# Timestamps
# ---------------------------------------------------------------------------


def format_sender_timestamp(now: float | None = None) -> str:
    """``YYYY-MM-DDTHH:MM:SSZ`` — second precision, ``Z`` suffix (``now`` in epoch seconds)."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if now is None else now))


def parse_sender_timestamp(ts: str) -> float:
    """Epoch seconds of a header ``ts`` (shape validated by the parser's regex).

    Raises :class:`ValueError` for an impossible date (month 13, …).
    """
    base = datetime.strptime(ts[:_TS_SECONDS_END], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)
    fraction = ts[_TS_SECONDS_END:-1]  # ".123" or ""
    return base.timestamp() + (float("0" + fraction) if fraction else 0.0)


# ---------------------------------------------------------------------------
# Signing
# ---------------------------------------------------------------------------


def build_signed_input(
    *, account: str, user: str, subject: str, ts: str, nonce: str, payload_sha256_hex: str
) -> bytes:
    """The exact bytes that are signed (never sent)."""
    return (
        f"{AGENT_SENDER_SIGNED_INPUT_TAG}\n{account}\n{user}\n{subject}\n{ts}\n{nonce}\n"
        f"{payload_sha256_hex}\n"
    ).encode()


async def sign_sender_header(
    *,
    signer: SenderSigner,
    id: AgentId,
    sub: str,
    payload: bytes,
    name: str | None = None,
    ts: str | None = None,
    nonce: str | None = None,
) -> AgentSenderHeader:
    """Build and sign a header. ``ts`` and ``nonce`` are fresh unless overridden (tests / vectors).

    ``sub`` is the subject to sign — what the caller publishes to (or the
    exporter's subject behind a rename by the caller's own account).
    """
    ts_value = ts if ts is not None else format_sender_timestamp()
    nonce_value = nonce if nonce is not None else _nuid.next().decode("ascii")
    data = build_signed_input(
        account=id.account,
        user=id.user,
        subject=sub,
        ts=ts_value,
        nonce=nonce_value,
        payload_sha256_hex=sha256_hex(payload),
    )
    sig = base64url_encode(await maybe_await(signer.sign(data)))
    return AgentSenderHeader(
        account=id.account,
        user=id.user,
        name=name,
        sub=sub,
        ts=ts_value,
        nonce=nonce_value,
        sig=sig,
    )


def build_claim_header(*, id: AgentId, name: str | None = None) -> AgentSenderHeader:
    """An unsigned claim: exactly ``v, account, user, name?``."""
    return AgentSenderHeader(account=id.account, user=id.user, name=name)


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


class NonceSeen(Protocol):
    """``live`` mode: ``True`` when the ``(user, nonce)`` pair was already seen."""

    def __call__(self, user: str, nonce: str, /) -> bool: ...


def normalize_account_token_position(position: int | None) -> int | None:
    """Validate ``account_token_position`` (1-based); returns it or ``None``."""
    if position is None:
        return None
    if isinstance(position, bool) or not isinstance(position, int) or position < 1:
        raise IdentityError("account_token_position must be an integer >= 1 (1-based)")
    return position


def check_subject_acceptance(
    *, account: str, sub: str, arrival_subject: str, account_token_position: int | None
) -> str | None:
    """``sub`` acceptance against the arrival subject — never against a pattern.

    Returns a rejection detail, or ``None`` when accepted. With a
    position configured, the token at that position of the arrival
    subject MUST equal the header's ``account`` (checked first, always);
    ``sub`` is then accepted by equality with the arrival subject or with
    the arrival subject minus that token.
    """
    if account_token_position is None:
        if sub == arrival_subject:
            return None
        return f"sub {sub!r} is not the arrival subject {arrival_subject!r}"
    tokens = arrival_subject.split(".")
    if account_token_position > len(tokens):
        return (
            f"account_token_position {account_token_position} is beyond the "
            f"{len(tokens)}-token arrival subject"
        )
    inserted = tokens[account_token_position - 1]
    if inserted != account:
        return (
            f"arrival subject token {inserted!r} at position {account_token_position} is not "
            f"the header account {account!r}"
        )
    stripped = ".".join(tokens[: account_token_position - 1] + tokens[account_token_position:])
    if sub in (arrival_subject, stripped):
        return None
    return f"sub {sub!r} is neither the arrival subject {arrival_subject!r} nor {stripped!r}"


def _reject(detail: str) -> SenderVerificationError:
    return SenderVerificationError(401, SENDER_REJECTED_DESCRIPTION, detail)


def verify_sender_header(
    header: AgentSenderHeader,
    arrival_subject: str,
    payload: bytes,
    *,
    mode: VerifyMode,
    account_token_position: int | None = None,
    replay_window_s: float | None = None,
    now: float | None = None,
    nonce_seen: NonceSeen | None = None,
    resolver: Callable[[AgentId], Awaitable[AgentInfo | None]] | None = None,
) -> SenderInfo:
    """Verify a parsed header against the message it arrived with.

    Check order (cheap first; the wire outcome is ``401`` either way):
    ``ts`` window (live) → ``sub`` acceptance → nonce lookup (live, via
    ``nonce_seen``) → ed25519. The nonce lookup deliberately precedes the
    signature so a replay — or a forgery reusing a seen nonce — costs no
    sha256/ed25519. An unsigned header yields a :class:`ClaimedSender`
    without any check. ``stored`` mode (JetStream consumers) skips the
    freshness checks and uses the stored subject as ``arrival_subject``:
    it proves authorship of content, not uniqueness — consumers dedupe on
    ``(user, nonce)``.

    **A returned :class:`VerifiedSender` does not mean the nonce was
    recorded.** This function only *looks up* nonces; the receiver
    records the nonce (check-and-set) after every other admission step
    passed. A caller that skips recording has no replay protection.

    Raises :class:`SenderVerificationError` (``.code == 401``) on a
    failing check.
    """
    if header.sig is None or header.sub is None or header.ts is None or header.nonce is None:
        return ClaimedSender(
            claim=SenderClaim(account=header.account, user=header.user),
            name=header.name,
            header=header,
        )
    position = normalize_account_token_position(account_token_position)

    if mode == "live":
        window = replay_window_s if replay_window_s is not None else DEFAULT_REPLAY_WINDOW_S
        current = time.time() if now is None else now
        skew = abs(current - parse_sender_timestamp(header.ts))
        if skew > window:
            raise _reject(f"ts {header.ts} is {skew:.0f} s from now (window {window:g} s)")

    subject_problem = check_subject_acceptance(
        account=header.account,
        sub=header.sub,
        arrival_subject=arrival_subject,
        account_token_position=position,
    )
    if subject_problem is not None:
        raise _reject(subject_problem)

    if mode == "live" and nonce_seen is not None and nonce_seen(header.user, header.nonce):
        raise _reject(f"nonce {header.nonce!r} already seen for {header.user}")

    data = build_signed_input(
        account=header.account,
        user=header.user,
        subject=header.sub,
        ts=header.ts,
        nonce=header.nonce,
        payload_sha256_hex=sha256_hex(payload),
    )
    if not verify_with_public_key(header.user, data, base64url_decode(header.sig)):
        raise _reject(f"signature does not verify for {header.user}")

    id = AgentId.new(header.account, header.user)
    bound = (lambda: resolver(id)) if resolver is not None else None
    return VerifiedSender(id=id, name=header.name, header=header, _resolver=bound)


class _MessageLike(Protocol):
    """Structural message shape: ``Msg`` from nats-py core and JetStream alike."""

    @property
    def subject(self) -> str: ...

    @property
    def data(self) -> bytes: ...

    @property
    def headers(self) -> Mapping[str, object] | None: ...


def verify_sender(
    msg: _MessageLike,
    mode: VerifyMode,
    *,
    account_token_position: int | None = None,
    replay_window_s: float | None = None,
    now: float | None = None,
    nonce_seen: NonceSeen | None = None,
    resolver: Callable[[AgentId], Awaitable[AgentInfo | None]] | None = None,
) -> SenderInfo | None:
    """The spec's ``VerifySender(msg, mode)`` over a structural message.

    ``msg.subject`` is the arrival subject (the stored subject for a
    JetStream record). Returns ``None`` when the message carries no
    ``Agent-Sender`` header or one with an unknown ``v``; otherwise
    :func:`verify_sender_header` applies (and may raise
    :class:`MalformedSenderHeaderError` / :class:`SenderVerificationError`).
    """
    value = read_sender_header_value(msg.headers)
    if value is None:
        return None
    header = parse_sender_header(value)
    if header is None:
        return None
    return verify_sender_header(
        header,
        msg.subject,
        msg.data,
        mode=mode,
        account_token_position=account_token_position,
        replay_window_s=replay_window_s,
        now=now,
        nonce_seen=nonce_seen,
        resolver=resolver,
    )


__all__ = [
    "AGENT_SENDER_HEADER",
    "AGENT_SENDER_SIGNED_INPUT_TAG",
    "AGENT_SENDER_VERSION",
    "DEFAULT_REPLAY_WINDOW_S",
    "MAX_SENDER_HEADER_VALUE_BYTES",
    "MAX_SENDER_NAME_LENGTH",
    "SENDER_HEADER_FRAMING_BYTES",
    "SENDER_REJECTED_DESCRIPTION",
    "SIGNATURE_REQUIRED_DESCRIPTION",
    "AgentSenderHeader",
    "ClaimedSender",
    "NonceSeen",
    "SenderClaim",
    "SenderInfo",
    "VerifiedSender",
    "VerifyMode",
    "assert_valid_sender_name",
    "build_claim_header",
    "build_signed_input",
    "check_subject_acceptance",
    "encoded_header_length",
    "expected_sender_header_bytes",
    "format_sender_timestamp",
    "max_sender_header_bytes",
    "normalize_account_token_position",
    "parse_sender_header",
    "parse_sender_timestamp",
    "read_sender_header_value",
    "serialize_sender_header",
    "sign_sender_header",
    "verify_sender",
    "verify_sender_header",
]

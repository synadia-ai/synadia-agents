"""Host-side sender classification — the stateful half of the sender-identity extension.

The shared codec in :mod:`synadia_ai.agents.identity` (parse, verify,
``SenderInfo``, ``format_sender``) deliberately carries no state. This
module adds what a receiver needs on top of it: the nonce set, the
``min_sender_trust`` gate, the acceptance hook, and the
``400`` / ``401`` / ``403`` / ``500`` mapping.

Dispatch order for a ``prompt`` request (plan §2.8)::

    envelope 400 → header parse 400 → ts / sub / nonce-lookup / signature 401
    → ``signed`` + unsigned 401 → nonce record → accept_sender 403 / 401,
    raise → 500 → ack

A nonce is recorded only after every other check passed, so a stale or
transplanted header cannot poison the set. ``status`` is classify-only.

The extension is additive to protocol ``0.3`` and is enabled explicitly
by caller and host configuration.
"""

from __future__ import annotations

import inspect
import logging
import math
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol, TypeAlias

from synadia_ai.agents import (
    MalformedSenderHeaderError,
    SenderVerificationError,
    VerifiedSender,
    format_sender,
    verify_sender,
)
from synadia_ai.agents.identity import (
    DEFAULT_REPLAY_WINDOW_S,
    SENDER_REJECTED_DESCRIPTION,
    SIGNATURE_REQUIRED_DESCRIPTION,
    normalize_account_token_position,
    parse_sender_timestamp,
)

from ._logging import get_logger

if TYPE_CHECKING:
    from synadia_ai.agents import AgentId, AgentInfo, MinSenderTrust, SenderInfo, SenderSigner

log = get_logger(__name__)

#: Default ``min_sender_trust`` — the 0.3 behaviour.
DEFAULT_MIN_SENDER_TRUST: MinSenderTrust = "any"
#: Default hard cap on nonce-set entries.
DEFAULT_NONCE_CACHE_MAX_ENTRIES = 100_000

_MIN_SENDER_TRUST_VALUES = ("any", "signed")

#: Acceptance hook: runs for every classified ``prompt`` request (verified,
#: claimed, absent), never for ``status``. ``False`` for a verified sender →
#: ``403``; ``False`` for a claimed / absent sender → ``401`` with the
#: ``signature required`` description — on the wire that reads as "sign and
#: retry", so a hook that wants to block an unsigned caller regardless of
#: signing cannot express that distinction (§9.2 leaves no code for it);
#: a raise → ``500`` (logged, never served). Per-request network I/O here
#: delays the §6.4 ack and is an amplification vector on ``any`` endpoints.
AcceptSenderHook: TypeAlias = Callable[["SenderInfo | None"], "bool | Awaitable[bool]"]

#: Reverse-lookup binding for ``VerifiedSender.resolve()``.
SenderResolverFn: TypeAlias = Callable[["AgentId"], Awaitable["AgentInfo | None"]]


@dataclass(frozen=True, slots=True)
class ServiceIdentity:
    """Sender-identity options of the host: the signer for ``id_sig``.

    The host never sends ``Agent-Sender`` (so there is no display name
    here); ``signer`` signs the ``AGENT-ID-V1`` registration signature
    over the prompt subject and must hold the live connection's user NKEY.
    When it carries a credentials JWT, that JWT's user and account must also
    match the live connection — :meth:`AgentService.start` raises an identity
    error if binding cannot be established.
    """

    signer: SenderSigner | None = None


class ClassifiableMsg(Protocol):
    """The structural message shape classification needs (``Msg``, ``micro.Request`` fit)."""

    @property
    def subject(self) -> str: ...

    @property
    def data(self) -> bytes: ...

    @property
    def headers(self) -> Mapping[str, object] | None: ...


class NonceCache:
    """Per-instance, in-memory nonce set keyed by ``{user}.{nonce}`` (plan §2.5).

    The nonce alphabet excludes ``.``, so the key is unambiguous.
    **Entries expire at ``ts + window``, not at arrival + window** — a
    header with ``ts = now + 29 s`` is legal and must still be rejected on
    replay at arrival + 31 s. Expiry is bucketed by second so sweeps are
    not O(n) per insert; a hard cap bounds memory (oldest buckets evicted
    first, logged once per overload).

    Documented limitations: instances behind the ``agents`` queue group do
    not share it, and a restart empties it; the ``ts`` window bounds both.
    """

    def __init__(
        self,
        *,
        replay_window_s: float = DEFAULT_REPLAY_WINDOW_S,
        max_entries: int = DEFAULT_NONCE_CACHE_MAX_ENTRIES,
        logger: logging.Logger | None = None,
    ) -> None:
        self._window = replay_window_s
        self._max = max_entries
        self._log = logger if logger is not None else log
        self._expiry: dict[str, float] = {}
        self._buckets: dict[int, set[str]] = {}
        self._cap_warned = False

    @property
    def size(self) -> int:
        return len(self._expiry)

    def has(self, user: str, nonce: str, now: float | None = None) -> bool:
        """``True`` iff ``(user, nonce)`` is present and not expired.

        The stored expiry is compared exactly; the second-granular buckets
        only bound *memory* (an entry can sit in the map for up to 1 s
        past its expiry before the sweep drops it, but it is never
        reported as present).
        """
        current = time.time() if now is None else now
        self.sweep(current)
        expires_at = self._expiry.get(f"{user}.{nonce}")
        return expires_at is not None and expires_at > current

    def record(self, user: str, nonce: str, ts_s: float, now: float | None = None) -> bool:
        """Check-and-set: record ``(user, nonce)`` expiring at ``ts_s + window``.

        Returns ``False`` (and records nothing) when it is already present
        and unexpired. Synchronous on purpose — it is the authoritative
        CAS when concurrent requests carry the same nonce: the earlier
        ``has()`` lookup inside classification is only the cheap early
        exit, and the receiver must not ``await`` between its last check
        and this call.
        """
        current = time.time() if now is None else now
        self.sweep(current)
        key = f"{user}.{nonce}"
        existing = self._expiry.get(key)
        if existing is not None:
            if existing > current:
                return False
            # Expired but not yet swept (its bucket is the current second):
            # drop it from that bucket so the sweep cannot later remove the
            # fresh entry recorded below under the same key.
            self._buckets.get(math.floor(existing), set()).discard(key)
        expires_at = ts_s + self._window
        if expires_at <= current:
            return True  # already outside the window: nothing to remember
        self._expiry[key] = expires_at
        self._buckets.setdefault(math.floor(expires_at), set()).add(key)
        self._enforce_cap()
        return True

    def sweep(self, now: float | None = None) -> None:
        """Drop every entry whose expiry bucket has passed.

        Once normal expiry has brought the set down to half the cap, the
        cap warning is re-armed so a later overload is reported again —
        with hysteresis, because every eviction round itself leaves the
        set just under the cap and a plain "below the cap" reset would log
        on every round.
        """
        current = time.time() if now is None else now
        now_bucket = math.floor(current)
        for bucket in [b for b in self._buckets if b < now_bucket]:
            for key in self._buckets.pop(bucket):
                self._expiry.pop(key, None)
        if self._cap_warned and len(self._expiry) <= self._max / 2:
            self._cap_warned = False

    def _enforce_cap(self) -> None:
        if len(self._expiry) <= self._max:
            return
        if not self._cap_warned:
            self._cap_warned = True
            # Evicted nonces are replayable for the rest of their `ts` window —
            # an operator who sees this once should raise the cap.
            self._log.warning(
                "nonce cache reached its cap (%d entries); evicting the oldest entries — "
                "evicted nonces may be replayed within the ts window",
                self._max,
            )
        for bucket in sorted(self._buckets):
            if len(self._expiry) <= self._max:
                break
            for key in self._buckets.pop(bucket):
                self._expiry.pop(key, None)


@dataclass(frozen=True, slots=True)
class SenderRejection:
    """A refusal: the wire code, the generic wire description, and the log-only detail."""

    code: int
    description: str
    detail: str


@dataclass(frozen=True, slots=True)
class SenderAdmission:
    """The outcome of :meth:`SenderGate.admit_prompt`: a sender to serve, or a rejection."""

    sender: SenderInfo | None = None
    rejection: SenderRejection | None = None

    @property
    def ok(self) -> bool:
        return self.rejection is None


class SenderGate:
    """Classifies inbound requests for one receiver.

    ``parse → verify (live) → min_sender_trust → nonce record →
    acceptance hook``. One gate per :class:`AgentService`; the nonce set
    lives in it. Hand-rolled services can use it directly.
    """

    def __init__(
        self,
        *,
        min_sender_trust: MinSenderTrust = DEFAULT_MIN_SENDER_TRUST,
        replay_window_s: float = DEFAULT_REPLAY_WINDOW_S,
        account_token_position: int | None = None,
        accept_sender: AcceptSenderHook | None = None,
        operator_attested: bool = False,
        resolver: SenderResolverFn | None = None,
        nonce_cache: NonceCache | None = None,
    ) -> None:
        if min_sender_trust not in _MIN_SENDER_TRUST_VALUES:
            raise ValueError(
                f'min_sender_trust must be "any" or "signed" (got {min_sender_trust!r})'
            )
        if not replay_window_s > 0:
            raise ValueError(f"replay_window_s must be > 0 (got {replay_window_s!r})")
        if not isinstance(operator_attested, bool):
            raise TypeError(f"operator_attested must be a bool (got {operator_attested!r})")
        self._min_sender_trust: MinSenderTrust = min_sender_trust
        self._replay_window_s = replay_window_s
        # Raises `IdentityError` for anything but an int >= 1.
        self._account_token_position = normalize_account_token_position(account_token_position)
        self._accept_sender = accept_sender
        self._operator_attested = operator_attested
        self._resolver = resolver
        self._nonces = (
            nonce_cache if nonce_cache is not None else NonceCache(replay_window_s=replay_window_s)
        )

    @property
    def min_sender_trust(self) -> MinSenderTrust:
        return self._min_sender_trust

    @property
    def nonce_cache(self) -> NonceCache:
        return self._nonces

    @property
    def operator_attested(self) -> bool:
        return self._operator_attested

    def classify(self, msg: ClassifiableMsg) -> SenderInfo | None | SenderRejection:
        """Parse and verify (live mode) without recording anything.

        A malformed header → ``400``; a failing check → ``401``; no header
        / unknown ``v`` → ``None``. Non-identity exceptions propagate.
        Synchronous: nothing in the verify path awaits.
        """
        try:
            return verify_sender(
                msg,
                "live",
                account_token_position=self._account_token_position,
                replay_window_s=self._replay_window_s,
                nonce_seen=self._nonces.has,
                resolver=self._resolver,
                operator_attested=self._operator_attested,
            )
        except MalformedSenderHeaderError as exc:
            return SenderRejection(400, "malformed Agent-Sender header", str(exc))
        except SenderVerificationError as exc:
            return SenderRejection(exc.code, exc.description, exc.detail)

    async def admit_prompt(self, msg: ClassifiableMsg) -> SenderAdmission:
        """The full ``prompt`` admission.

        Classify, enforce ``min_sender_trust``, record the nonce
        (check-and-set), run the acceptance hook. Never raises for identity
        reasons; logs every refusal with its detail.
        """
        classified = self.classify(msg)
        if isinstance(classified, SenderRejection):
            return self._refuse(msg, classified)
        sender = classified

        if self._min_sender_trust == "signed" and not isinstance(sender, VerifiedSender):
            return self._refuse(
                msg,
                SenderRejection(
                    401,
                    SIGNATURE_REQUIRED_DESCRIPTION,
                    f"endpoint requires a verified sender; got {format_sender(sender)}",
                ),
            )

        if isinstance(sender, VerifiedSender):
            header = sender.header
            # CAS: synchronous check-and-set; one winner when concurrent requests
            # carry the same nonce. Atomic because no `await` separates
            # `classify()` (itself synchronous) from this call — the event loop
            # cannot interleave another request's `record()` in between; the
            # earlier `has()` lookup inside `classify()` is only the cheap early
            # exit.
            if (
                header.nonce is not None
                and header.ts is not None
                and not self._nonces.record(
                    header.user, header.nonce, parse_sender_timestamp(header.ts)
                )
            ):
                return self._refuse(
                    msg,
                    SenderRejection(
                        401,
                        SENDER_REJECTED_DESCRIPTION,
                        f"nonce already seen for {header.user}",
                    ),
                )

        if self._accept_sender is not None:
            try:
                accepted = await _call_hook(self._accept_sender, sender)
            except Exception as exc:
                # Hook exceptions are application-controlled and may contain
                # credentials, header values, or other secrets. Log only the
                # exception type; neither its message nor traceback is safe.
                log.error(
                    "accept_sender hook raised on %s (sender %s; error %s); request not served",
                    msg.subject,
                    format_sender(sender),
                    type(exc).__name__,
                )
                # The generic text: the wire must not disclose that a hook exists.
                return SenderAdmission(
                    rejection=SenderRejection(500, "server error", "accept_sender hook raised")
                )
            if not accepted:
                if isinstance(sender, VerifiedSender):
                    rejection = SenderRejection(
                        403,
                        SENDER_REJECTED_DESCRIPTION,
                        f"verified sender not accepted: {format_sender(sender)}",
                    )
                else:
                    rejection = SenderRejection(
                        401,
                        SIGNATURE_REQUIRED_DESCRIPTION,
                        f"unauthenticated sender not accepted: {format_sender(sender)}",
                    )
                return self._refuse(msg, rejection)

        return SenderAdmission(sender=sender)

    def classify_status(self, msg: ClassifiableMsg) -> SenderInfo | None:
        """``status``: classify, record a verified nonce into the shared set, log a failure.

        Never rejects. Returns the sender for the log line (``None`` when
        the classification failed or the nonce was a replay).
        """
        classified = self.classify(msg)
        if isinstance(classified, SenderRejection):
            log.warning(
                "status request on %s: Agent-Sender rejected (%d: %s); reply sent anyway",
                msg.subject,
                classified.code,
                classified.detail,
            )
            return None
        sender = classified
        if isinstance(sender, VerifiedSender):
            header = sender.header
            # The same CAS as in `admit_prompt`. In a single asyncio loop the
            # `False` branch is unreachable — `classify()` is synchronous, so
            # nothing can claim the nonce between its `has()` lookup and this
            # `record()`; a replay is caught by that lookup (`401 … already
            # seen`, logged above). The guard stays for a shared cache across
            # threads or a future `await` slipped in between.
            if (
                header.nonce is not None
                and header.ts is not None
                and not self._nonces.record(
                    header.user, header.nonce, parse_sender_timestamp(header.ts)
                )
            ):
                log.warning(
                    "status request on %s: nonce replayed by %s; reply sent anyway",
                    msg.subject,
                    format_sender(sender),
                )
                return None
        return sender

    def _refuse(self, msg: ClassifiableMsg, rejection: SenderRejection) -> SenderAdmission:
        log.warning(
            "prompt request refused on sender identity on %s: %d %s",
            msg.subject,
            rejection.code,
            rejection.detail,
        )
        return SenderAdmission(rejection=rejection)


async def _call_hook(hook: AcceptSenderHook, sender: SenderInfo | None) -> bool:
    result = hook(sender)
    if inspect.isawaitable(result):
        return bool(await result)
    return bool(result)


__all__ = [
    "DEFAULT_MIN_SENDER_TRUST",
    "DEFAULT_NONCE_CACHE_MAX_ENTRIES",
    "DEFAULT_REPLAY_WINDOW_S",
    "AcceptSenderHook",
    "ClassifiableMsg",
    "NonceCache",
    "SenderAdmission",
    "SenderGate",
    "SenderRejection",
    "SenderResolverFn",
    "ServiceIdentity",
]

"""``self_id()`` — the connection's own agent ID.

The live identity comes from ``$SYS.REQ.USER.INFO``. When a signer is
configured, its user key and (for credentials signers) account are compared
with that live answer before the identity can be used.

Signer-less diagnostic lookups are memoised per connection in a module-level
:class:`weakref.WeakKeyDictionary`
(``nats.aio.client.Client`` is weak-referenceable): one in-flight lookup
task shared by concurrent callers, success kept for the connection's
lifetime, **every failure a negative cache with a 30 s TTL** (a raced or
transient answer must not stick). :func:`refresh_self_id` forces a retry.
nats-py exposes no reconnect event on an existing client, so signed and
unsigned request paths do not consume this memo: they perform an uncached
live lookup for every identity-bearing operation.

Fast-fail: the server reports a permissions violation on ``$SYS.>`` as an
asynchronous ``-ERR`` that nats-py keeps as ``Client.last_error``
(lower-cased: ``nats: permissions violation for publish to
"$sys.req.user.info"``). The lookup polls it every 50 ms while waiting
and fails at once with :class:`IdentityUnavailableError` — no 2 s
timeout. A server without the responder answers 503 → immediate too.
"""

from __future__ import annotations

import asyncio
import json
import time
import weakref
from dataclasses import dataclass
from typing import TYPE_CHECKING

from nats.errors import NoRespondersError

from .._request import request_one
from ..errors import (
    IdentityError,
    IdentityMismatchError,
    IdentityUnavailableError,
    NoIdentityError,
)
from .agent_id import (
    ACCOUNT_LENGTH_ALLOWANCE_BYTES,
    AgentId,
    assert_valid_account,
    is_user_key_shaped,
)
from .signer import SenderSigner, identity_from_jwt

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

USER_INFO_SUBJECT = "$SYS.REQ.USER.INFO"
#: Spec default timeout for the ``$SYS.REQ.USER.INFO`` request.
SELF_ID_TIMEOUT_S = 2.0
#: How long a failed lookup is remembered before a retry may run.
SELF_ID_NEGATIVE_TTL_S = 30.0
_PERMISSION_POLL_S = 0.05
_REDACTED_USER = "[REDACTED]"


@dataclass(slots=True)
class _Entry:
    inflight: asyncio.Task[AgentId | IdentityError] | None = None
    settled_id: AgentId | None = None
    settled_error: IdentityError | None = None
    failed_at: float = 0.0


_memo: weakref.WeakKeyDictionary[NATSClient, _Entry] = weakref.WeakKeyDictionary()
_background_bindings: set[asyncio.Task[AgentId]] = set()


def _entry_for(nc: NATSClient) -> _Entry:
    entry = _memo.get(nc)
    if entry is None:
        entry = _Entry()
        _memo[nc] = entry
    return entry


def _failure_expired(entry: _Entry, now: float) -> bool:
    return now - entry.failed_at >= SELF_ID_NEGATIVE_TTL_S


def peek_self_id(nc: NATSClient) -> AgentId | IdentityError | None:
    """The memoised result, synchronously.

    The id, the failure (an exception object) still inside its
    negative-cache TTL, or ``None`` (never looked up, in flight, or an
    expired failure).
    """
    entry = _memo.get(nc)
    if entry is None:
        return None
    if entry.settled_id is not None:
        return entry.settled_id
    if entry.settled_error is not None and not _failure_expired(entry, time.monotonic()):
        return entry.settled_error
    return None


def self_id_failure_expired(nc: NATSClient) -> bool:
    """True when the memo holds a failure whose negative-cache TTL has elapsed."""
    entry = _memo.get(nc)
    return (
        entry is not None
        and entry.settled_error is not None
        and _failure_expired(entry, time.monotonic())
    )


def _inflight(entry: _Entry) -> asyncio.Task[AgentId | IdentityError] | None:
    """The running lookup task, or ``None`` — a done task (including one cancelled
    before its first step, whose body never ran) is dropped from the entry."""
    task = entry.inflight
    if task is not None and task.done():
        entry.inflight = None
        return None
    return task


def is_self_id_inflight(nc: NATSClient) -> bool:
    """True while a lookup is in flight on this connection."""
    entry = _memo.get(nc)
    return entry is not None and _inflight(entry) is not None


async def self_id(
    nc: NATSClient, *, signer: SenderSigner | None = None, timeout_s: float = SELF_ID_TIMEOUT_S
) -> AgentId:
    """The connection's agent ID.

    Awaits at most one lookup; repeats the memoised answer (or failure,
    inside its TTL) afterwards. Raises :class:`NoIdentityError`,
    :class:`IdentityUnavailableError` or :class:`IdentityMismatchError`.
    """
    # A signer turns this into a connection-binding operation. nats-py has no
    # public reconnect generation, so a prior answer must never satisfy it.
    if signer is not None:
        return await lookup_self_id(nc, signer=signer, timeout_s=timeout_s)
    entry = _entry_for(nc)
    if entry.settled_id is not None:
        return entry.settled_id
    if entry.settled_error is not None and not _failure_expired(entry, time.monotonic()):
        raise entry.settled_error
    return await _await_lookup(nc, entry, signer, timeout_s)


async def refresh_self_id(
    nc: NATSClient, *, signer: SenderSigner | None = None, timeout_s: float = SELF_ID_TIMEOUT_S
) -> AgentId:
    """Force a new lookup, discarding any memoised answer (shares an in-flight one)."""
    if signer is not None:
        return await lookup_self_id(nc, signer=signer, timeout_s=timeout_s)
    entry = _entry_for(nc)
    if _inflight(entry) is None:
        entry.settled_id = None
        entry.settled_error = None
        entry.failed_at = 0.0
    return await _await_lookup(nc, entry, signer, timeout_s)


def start_self_id_lookup(
    nc: NATSClient, *, signer: SenderSigner | None = None, timeout_s: float = SELF_ID_TIMEOUT_S
) -> None:
    """Fire-and-forget: start the lookup if nothing is memoised or in flight.

    Signer-less diagnostic lookups capture their outcome into the memo.
    A signer starts an uncached one-off binding check and never consumes or
    populates the signer-less memo. Call this from a running async SDK path;
    like the rest of the client, its background task requires an active event
    loop.
    """
    if signer is not None:
        task = asyncio.create_task(
            lookup_self_id(nc, signer=signer, timeout_s=timeout_s),
            name="agents-self-id-binding",
        )
        _background_bindings.add(task)
        task.add_done_callback(_consume_background_lookup)
        return
    entry = _entry_for(nc)
    if _inflight(entry) is not None or entry.settled_id is not None:
        return
    if entry.settled_error is not None and not _failure_expired(entry, time.monotonic()):
        return
    _start_task(nc, entry, signer, timeout_s)


def _consume_background_lookup(task: asyncio.Task[AgentId]) -> None:
    """Retrieve a fire-and-forget binding outcome without logging its detail."""
    _background_bindings.discard(task)
    if task.cancelled():
        return
    try:
        task.exception()
    except asyncio.CancelledError:
        return


def _start_task(
    nc: NATSClient, entry: _Entry, signer: SenderSigner | None, timeout_s: float
) -> asyncio.Task[AgentId | IdentityError]:
    # Check-and-create is synchronous (no await between the `inflight`
    # test and the assignment), so concurrent callers on one event loop
    # cannot race it; no lock is needed.
    task = asyncio.create_task(_run_lookup(nc, entry, signer, timeout_s), name="agents-self-id")
    entry.inflight = task
    return task


async def _await_lookup(
    nc: NATSClient, entry: _Entry, signer: SenderSigner | None, timeout_s: float
) -> AgentId:
    # A task that was cancelled *itself* (not through a caller — callers
    # are shielded) has settled nothing and reads as "not in flight"; start
    # over rather than re-raising its `CancelledError` forever.
    task = _inflight(entry)
    if task is None:
        task = _start_task(nc, entry, signer, timeout_s)
    # Shielded: a cancelled caller must not cancel the shared lookup.
    outcome = await asyncio.shield(task)
    if isinstance(outcome, IdentityError):
        raise outcome
    return outcome


async def _run_lookup(
    nc: NATSClient, entry: _Entry, signer: SenderSigner | None, timeout_s: float
) -> AgentId | IdentityError:
    """The shared lookup task. Never raises on its own: the outcome is stored and returned.

    Only a cancellation of the task itself escapes; the ``finally`` clears
    ``entry.inflight`` for that case, and :func:`_inflight` drops a done
    task regardless (a task cancelled before its first step never runs
    this body at all), so the next call starts a fresh lookup instead of
    awaiting a done-but-cancelled task.
    """
    try:
        try:
            result: AgentId | IdentityError = await lookup_self_id(
                nc, signer=signer, timeout_s=timeout_s
            )
        except IdentityError as exc:
            result = exc
        except Exception as exc:
            result = IdentityUnavailableError(f"{USER_INFO_SUBJECT} request failed: {exc}")
        if isinstance(result, IdentityError):
            entry.settled_id = None
            entry.settled_error = result
            entry.failed_at = time.monotonic()
        else:
            entry.settled_id = result
            entry.settled_error = None
            entry.failed_at = 0.0
        return result
    finally:
        if entry.inflight is asyncio.current_task():
            entry.inflight = None


async def lookup_self_id(
    nc: NATSClient, *, signer: SenderSigner | None = None, timeout_s: float = SELF_ID_TIMEOUT_S
) -> AgentId:
    """One uncached live lookup, with optional signer-to-connection binding.

    A configured signer must match the live user. A credentials signer must
    additionally carry the same account as the live connection. A mismatch
    raises :class:`IdentityMismatchError`; inability to obtain the live answer
    remains :class:`IdentityUnavailableError` and never silently downgrades a
    signed operation.
    """
    live_id = await _request_user_info(nc, timeout_s)
    if signer is None:
        return live_id
    if live_id.user != signer.public_key:
        raise IdentityMismatchError(signer.public_key, live_id.user)
    if signer.jwt is not None:
        signer_id = identity_from_jwt(signer.jwt)
        if signer_id.user != signer.public_key:
            raise IdentityMismatchError(
                signer.public_key,
                live_id.user,
                credential_user=signer_id.user,
            )
        if signer_id.account != live_id.account:
            raise IdentityMismatchError(
                signer.public_key,
                live_id.user,
                signer_account=signer_id.account,
                identity_account=live_id.account,
            )
    return live_id


async def _request_user_info(nc: NATSClient, timeout_s: float) -> AgentId:
    before = nc.last_error

    def _permission_violation() -> Exception | None:
        err = nc.last_error
        if err is None or err is before:
            return None
        text = str(err).lower()
        if "permissions violation" in text and USER_INFO_SUBJECT.lower() in text:
            return IdentityUnavailableError(
                f"publish to {USER_INFO_SUBJECT} is a permissions violation for this user"
            )
        return None

    try:
        msg = await request_one(
            nc,
            USER_INFO_SUBJECT,
            b"",
            timeout_s=timeout_s,
            poll_s=_PERMISSION_POLL_S,
            abort_check=_permission_violation,
        )
    except IdentityError:
        raise
    except NoRespondersError as exc:
        raise IdentityUnavailableError(
            f"no responder for {USER_INFO_SUBJECT} (server without the system responder?)"
        ) from exc
    except TimeoutError as exc:
        raise IdentityUnavailableError(
            f"no reply from {USER_INFO_SUBJECT} within {timeout_s:g} s"
        ) from exc
    except Exception as exc:
        raise IdentityUnavailableError(f"{USER_INFO_SUBJECT} request failed: {exc}") from exc
    try:
        reply = json.loads(msg.data)
    except ValueError as exc:
        raise IdentityUnavailableError(f"{USER_INFO_SUBJECT} reply is not JSON") from exc
    return identity_from_user_info_reply(reply)


def identity_from_user_info_reply(reply: object) -> AgentId:
    """Derive the agent ID from a parsed ``$SYS.REQ.USER.INFO`` reply.

    ``{"data": {"user", "account", ...}}`` — unknown fields
    (``account_name``, ``permissions``, ``expires``) are ignored.
    :class:`NoIdentityError` when the connection has no NKEY user or the
    account name is not representable; :class:`IdentityUnavailableError`
    when the reply is not the expected shape.
    """
    if not isinstance(reply, dict):
        raise IdentityUnavailableError(f"{USER_INFO_SUBJECT} reply is not a JSON object")
    if reply.get("error") is not None:
        raise IdentityUnavailableError(
            f"{USER_INFO_SUBJECT} answered with an error: {json.dumps(reply['error'])}"
        )
    data = reply.get("data")
    if not isinstance(data, dict):
        raise IdentityUnavailableError(f"{USER_INFO_SUBJECT} reply has no `data` object")
    user = data.get("user")
    account = data.get("account")
    if not isinstance(user, str) or not isinstance(account, str):
        raise IdentityUnavailableError(f"{USER_INFO_SUBJECT} reply lacks string `user` / `account`")
    if user == "":
        raise NoIdentityError("no authentication — the server reports an empty user")
    if user == _REDACTED_USER:
        raise NoIdentityError("token authentication — the server reports a redacted user")
    if not is_user_key_shaped(user):
        raise NoIdentityError(
            f"password authentication — the server reports the user name {user!r}, not an NKEY"
        )
    if len(account.encode("utf-8")) > ACCOUNT_LENGTH_ALLOWANCE_BYTES:
        raise NoIdentityError(
            f"the account name is longer than {ACCOUNT_LENGTH_ALLOWANCE_BYTES} bytes and cannot "
            "be carried by the agent-ID form"
        )
    try:
        assert_valid_account(account)
    except IdentityError as exc:
        raise NoIdentityError(
            f"the account name {account!r} cannot be carried by the agent-ID form ({exc})"
        ) from exc
    return AgentId.new(account, user)


__all__ = [
    "SELF_ID_NEGATIVE_TTL_S",
    "SELF_ID_TIMEOUT_S",
    "USER_INFO_SUBJECT",
    "identity_from_user_info_reply",
    "is_self_id_inflight",
    "lookup_self_id",
    "peek_self_id",
    "refresh_self_id",
    "self_id",
    "self_id_failure_expired",
    "start_self_id_lookup",
]

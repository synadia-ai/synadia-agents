"""``self_id()`` — sources, memoisation, negative cache, fast-fail (T0 / T1 / T1-deny).

Unit rows over stubbed ``$SYS.REQ.USER.INFO`` replies first, then real
servers: no auth (``NoIdentityError``), one nkey user (``$G.U…``), a
mismatched signer, and ``deny: "$SYS.>"`` — where the SDK fails at once
on the asynchronous permissions violation instead of waiting 2 s,
memoises the failure for the TTL, and never blocks ``discover()``.
"""

from __future__ import annotations

import asyncio
import importlib
import time
from typing import TYPE_CHECKING, Any

import nats
import pytest

from synadia_ai.agents import (
    AgentId,
    Agents,
    Identity,
    IdentityMismatchError,
    IdentityUnavailableError,
    NoIdentityError,
    peek_self_id,
    refresh_self_id,
    self_id,
    signer_from_seed,
)
from synadia_ai.agents.identity import (
    USER_INFO_SUBJECT,
    identity_from_user_info_reply,
    self_id_failure_expired,
    start_self_id_lookup,
)
from tests.harness.wait import wait_for
from tests.test_signer_creds import fake_jwt

if TYPE_CHECKING:
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser, DenySysClient, EvidenceFor, NkeyUser
    from tests.harness.nats_server import RunningServer

A = "AABYLMBR6Q2CDXTLGRQCFA2GP76BGCDF7NZF2OVHH4RQ7L3Y3TZWJDRL"
OPERATOR_FORM_LENGTH = 113
FAST_FAIL_BUDGET_S = 1.0
DISCOVER_BUDGET_S = 1.5
SHORT_TTL_S = 0.6
CONCURRENT_CALLERS = 5


def _reply(data: dict[str, Any]) -> dict[str, Any]:
    return {"server": {"name": "x"}, "data": {"permissions": {}, "expires": 0, **data}}


# --- unit: stubbed replies (T1-deny rows) ---------------------------------------


def test_reply_operator_and_config_modes(identity_keys: dict[str, NkeyUser]) -> None:
    u = identity_keys["alice"].public
    assert identity_from_user_info_reply(_reply({"user": u, "account": A})) == f"{A}.{u}"
    assert len(identity_from_user_info_reply(_reply({"user": u, "account": A}))) == (
        OPERATOR_FORM_LENGTH
    )
    named = identity_from_user_info_reply(
        _reply({"user": u, "account": "ACME", "account_name": "ACME"})
    )
    assert named == f"ACME.{u}"
    assert identity_from_user_info_reply(_reply({"user": u, "account": "$G"})) == f"$G.{u}"


@pytest.mark.parametrize(
    ("label", "data", "needle"),
    [
        ("no auth", {"user": "", "account": "$G"}, "no authentication"),
        ("password user", {"user": "alice", "account": "$G"}, "password authentication"),
        ("token user", {"user": "[REDACTED]", "account": "$G"}, "token authentication"),
        ("name with a space", {"user": "U", "account": "acme corp"}, "cannot be carried"),
        ("name with a dot", {"user": "U", "account": "a.b"}, "cannot be carried"),
        ("name over 64 bytes", {"user": "U", "account": "x" * 65}, "longer than 64"),
        ("bad-CRC account key", {"user": "U", "account": A[:55] + "M"}, "cannot be carried"),
    ],
)
def test_reply_no_identity(
    identity_keys: dict[str, NkeyUser], label: str, data: dict[str, str], needle: str
) -> None:
    if data["user"] == "U":
        data = {**data, "user": identity_keys["alice"].public}
    with pytest.raises(NoIdentityError) as exc_info:
        identity_from_user_info_reply(_reply(data))
    message = str(exc_info.value)
    assert needle in message, label
    assert "configure an nkey user" in message and "credentials file" in message


def test_reply_unavailable_shapes() -> None:
    for bad in ("nope", {}, {"data": {"user": 1, "account": "$G"}}, {"error": {"code": 500}}):
        with pytest.raises(IdentityUnavailableError):
            identity_from_user_info_reply(bad)


# --- T0: no auth --------------------------------------------------------------


async def test_t0_no_identity_names_the_fix_and_is_asked_once(
    nats_server: RunningServer, evidence_for: EvidenceFor
) -> None:
    nc = await nats.connect(nats_server.url)
    try:
        recorder = await evidence_for(nc)
        probes: list[Msg] = []

        async def spy(msg: Msg) -> None:
            probes.append(msg)

        await nc.subscribe(USER_INFO_SUBJECT, cb=spy)
        await nc.flush()
        agents = Agents(nc=nc)
        with pytest.raises(NoIdentityError, match="configure an nkey user"):
            await agents.self_id()
        with pytest.raises(NoIdentityError):
            await agents.self_id()  # negative-cached: no second request
        assert isinstance(peek_self_id(nc), NoIdentityError)
        await wait_for(lambda: len(probes) == 1, what="one $SYS.REQ.USER.INFO probe")
        await nc.flush()
        assert len(probes) == 1  # still one: the negative cache answered the second call
        recorder.write_json(
            "probes.json", [{"subject": m.subject, "reply": m.reply} for m in probes]
        )
        await agents.close()
    finally:
        await nc.close()


# --- T1: nkey user, $G --------------------------------------------------------


async def test_t1_self_id_is_global_account_user_and_lookups_are_shared(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    alice = identity_keys["alice"]
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    probes: list[Msg] = []

    async def spy(msg: Msg) -> None:
        probes.append(msg)

    await nc.subscribe(USER_INFO_SUBJECT, cb=spy)
    await nc.flush()
    agents = Agents(nc=nc, identity=Identity(signer=signer_from_seed(alice.seed)))
    expected = AgentId.new("$G", alice.public)
    results = await asyncio.gather(*(agents.self_id() for _ in range(CONCURRENT_CALLERS)))
    assert all(r == expected for r in results)
    assert await self_id(nc) == expected  # module-level, same memo
    assert peek_self_id(nc) == expected
    await wait_for(lambda: len(probes) == 1, what="one $SYS.REQ.USER.INFO probe")
    await nc.flush()
    assert len(probes) == 1  # concurrent callers shared one in-flight lookup
    assert await agents.refresh_self_id() == expected
    assert await refresh_self_id(nc) == expected
    await wait_for(lambda: len(probes) == 3, what="three probes after two refreshes")
    await agents.close()


async def test_t1_mismatched_signer(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    # A dedicated connection: the mismatch is negative-cached per connection.
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    agents = Agents(nc=nc, identity=Identity(signer=signer_from_seed(identity_keys["bob"].seed)))
    with pytest.raises(IdentityMismatchError) as exc_info:
        await agents.self_id()
    assert identity_keys["bob"].public in str(exc_info.value)
    assert identity_keys["alice"].public in str(exc_info.value)
    assert isinstance(peek_self_id(nc), IdentityMismatchError)
    await agents.close()


# --- T1-deny: nkey user, deny $SYS.> ----------------------------------------------


async def test_t1_deny_fails_fast_and_memoises(
    nc_alice_deny_sys: DenySysClient, identity_keys: dict[str, NkeyUser], evidence_for: EvidenceFor
) -> None:
    nc = nc_alice_deny_sys.nc
    recorder = await evidence_for(nc)
    agents = Agents(nc=nc, identity=Identity(signer=signer_from_seed(identity_keys["alice"].seed)))
    started = time.monotonic()
    with pytest.raises(IdentityUnavailableError, match="permissions violation"):
        await agents.self_id()
    first = time.monotonic() - started
    assert first < FAST_FAIL_BUDGET_S
    assert not nc.is_closed
    assert isinstance(peek_self_id(nc), IdentityUnavailableError)

    started = time.monotonic()
    with pytest.raises(IdentityUnavailableError):
        await agents.self_id()  # inside the TTL: immediate, no request
    assert time.monotonic() - started < 0.05

    started = time.monotonic()
    with pytest.raises(IdentityUnavailableError):
        await agents.refresh_self_id()  # retries at once, fails fast again
    assert time.monotonic() - started < FAST_FAIL_BUDGET_S
    recorder.write_json(
        "timing.json", {"first_s": first, "errors": [str(e) for e in nc_alice_deny_sys.errors]}
    )
    await agents.close()


async def test_t1_deny_negative_cache_expires_and_retries_in_the_background(
    nats_server_nkey_deny_sys: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    self_id_module = importlib.import_module("synadia_ai.agents.identity.self_id")
    monkeypatch.setattr(self_id_module, "SELF_ID_NEGATIVE_TTL_S", SHORT_TTL_S)
    nc = await connect_nkey_user(nats_server_nkey_deny_sys, "alice")
    with pytest.raises(IdentityUnavailableError):
        await self_id(nc)
    assert isinstance(peek_self_id(nc), IdentityUnavailableError)
    assert not self_id_failure_expired(nc)
    await asyncio.sleep(SHORT_TTL_S + 0.1)
    assert peek_self_id(nc) is None  # expired: reads as "unknown" again
    assert self_id_failure_expired(nc)
    start_self_id_lookup(nc)  # what a prompt does past the TTL: retry behind the request
    await asyncio.sleep(SHORT_TTL_S / 2)  # the fast-fail retry lands well inside the new TTL
    assert isinstance(peek_self_id(nc), IdentityUnavailableError)  # failed again, freshly memoised
    assert not self_id_failure_expired(nc)


async def test_t1_deny_discover_does_not_block(
    nats_server_nkey_deny_sys: RunningServer, connect_nkey_user: ConnectNkeyUser
) -> None:
    nc = await connect_nkey_user(nats_server_nkey_deny_sys, "alice")
    agents = Agents(nc=nc)
    started = time.monotonic()
    await agents.discover(timeout=0.3)
    assert time.monotonic() - started < DISCOVER_BUDGET_S
    await agents.close()


async def test_t1_deny_creds_signer_reads_the_jwt_without_asking_the_server(
    nats_server_nkey_deny_sys: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    alice = identity_keys["alice"]
    jwt = fake_jwt({"sub": alice.public, "iss": A, "nats": {"type": "user"}})
    nc = await connect_nkey_user(nats_server_nkey_deny_sys, "alice")
    before = nc.last_error
    agents = Agents(nc=nc, identity=Identity(signer=signer_from_seed(alice.seed, jwt)))
    id = await agents.self_id()
    assert len(id) == OPERATOR_FORM_LENGTH
    assert id.account == A and id.user == alice.public
    await nc.flush()
    assert nc.last_error is before  # no `$SYS.REQ.USER.INFO` publish → no violation
    await agents.close()

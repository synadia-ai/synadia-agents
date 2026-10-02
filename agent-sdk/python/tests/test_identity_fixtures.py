"""Sender-identity test infrastructure: the shared fixtures + the config-capable harness.

Two halves:

* **Unit (no server):** the repo-level fixtures under
  ``test-fixtures/identity/`` are internally consistent — every ``nkey``
  literal in every ``.conf`` is a ``keys.json`` user and each config names
  exactly the users its topology promises (the configs carry literal keys,
  no templating, so a regenerated ``keys.json`` without a matching config
  edit fails *here*), every seed derives its public key, and
  ``agent-id-fixtures.json`` is well-formed.
* **E2E (real nats-server):** each fixture config boots through
  ``start_server(config_path=…)``, the throwaway users authenticate with
  ``nkeys_seed_str``, and each topology does what its header comment says
  (deny ``$SYS.>`` bites; cross-account imports deliver;
  ``account_token_position`` inserts the token; JetStream comes up on
  ``-js``); a rejected config fails ``start_server`` fast with the reason.

These prove the fixtures and the harness only. The identity behaviour
itself (``Agent-Sender``, ``self_id`` …) is tested elsewhere. This file is
byte-identical in ``client-sdk/python`` and ``agent-sdk/python``.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from typing import TYPE_CHECKING

import nats
import nats.errors
import nkeys
import pytest

from tests.harness.evidence import EvidenceRecorder
from tests.harness.nats_server import (
    IDENTITY_FIXTURES_DIR,
    find_nats_server,
    identity_fixture,
    start_server,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser, DenySysClient, NkeyUser
    from tests.harness.nats_server import RunningServer

EVIDENCE_ROOT = Path(__file__).parent / "_evidence"

#: Which keys.json users each fixture config must name — its topology, pinned.
EXPECTED_USERS_PER_CONF: dict[str, frozenset[str]] = {
    "nkey-noaccounts.conf": frozenset({"alice"}),
    "nkey-deny-sys.conf": frozenset({"alice"}),
    "accounts.conf": frozenset({"alice", "bob", "carol", "dave", "erin"}),
    "account-token-position.conf": frozenset({"alice", "bob", "dave"}),
    "closed-import.conf": frozenset({"alice", "bob", "carol"}),
}
ALL_USERS = frozenset({"alice", "bob", "carol", "dave", "erin"})
USER_KEY = re.compile(r"^U[A-Z2-7]{55}$")
USER_SEED = re.compile(r"^SU[A-Z2-7]{56}$")
NKEY_LITERAL = re.compile(r'nkey:\s*"([^"]*)"')
OPERATOR_FORM_LENGTH = 113
SPEC_ROW_COUNT = 10
REQUEST_TIMEOUT_S = 2.0
FAST_FAIL_BUDGET_S = 4.0


def _evidence(request: pytest.FixtureRequest) -> EvidenceRecorder:
    """Evidence dir for this test (not attached to a connection — the
    identity servers are separate from the session server the ``evidence``
    fixture spies on)."""
    return EvidenceRecorder.for_test(EVIDENCE_ROOT, request.node.nodeid)


# --- unit: fixture consistency ---------------------------------------------


def test_keys_json_lists_five_users_whose_seeds_derive_their_public_keys(
    identity_keys: dict[str, NkeyUser],
) -> None:
    assert frozenset(identity_keys) == ALL_USERS
    for user in identity_keys.values():
        assert USER_KEY.match(user.public), user.name
        assert USER_SEED.match(user.seed), user.name
        keypair = nkeys.from_seed(bytearray(user.seed.encode()))
        assert keypair.public_key.decode() == user.public, user.name
    assert len({u.public for u in identity_keys.values()}) == len(ALL_USERS)


def test_every_conf_nkey_literal_is_a_keys_json_user_and_each_conf_names_its_users(
    identity_keys: dict[str, NkeyUser],
) -> None:
    by_public = {user.public: name for name, user in identity_keys.items()}
    confs = sorted(p.name for p in IDENTITY_FIXTURES_DIR.glob("*.conf"))
    assert confs == sorted(EXPECTED_USERS_PER_CONF)

    used: set[str] = set()
    for conf in confs:
        literals = NKEY_LITERAL.findall(identity_fixture(conf).read_text(encoding="utf-8"))
        assert literals, f"{conf}: no nkey literals"
        unknown = [key for key in literals if key not in by_public]
        assert not unknown, f"{conf}: nkey literals not in keys.json: {unknown}"
        names = {by_public[key] for key in literals}
        assert names == EXPECTED_USERS_PER_CONF[conf], conf
        used |= names
    # No orphan users: every key in keys.json is wired into some topology.
    assert used == frozenset(identity_keys)


def test_agent_id_fixtures_are_well_formed() -> None:
    data = json.loads(identity_fixture("agent-id-fixtures.json").read_text(encoding="utf-8"))
    parse = data["parse"]
    assert len(parse) >= SPEC_ROW_COUNT
    assert [row["valid"] for row in parse[:SPEC_ROW_COUNT]] == [True] * 3 + [False] * 7
    regex = re.compile(data["regex"])
    for row in parse:
        if row["valid"]:
            assert row["input"] == f"{row['account']}.{row['user']}", row["note"]
            assert regex.match(row["input"]), row["note"]
            assert USER_KEY.match(row["user"]), row["note"]
            if "length" in row:
                assert len(row["input"]) == row["length"], row["note"]
        else:
            # The shape regex rejects every invalid row except the bad-CRC
            # one — catching that is the nkeys check's job, not the regex's.
            assert (regex.match(row["input"]) is not None) == ("CRC" in row["note"]), row["note"]
    assert len(parse[0]["input"]) == OPERATOR_FORM_LENGTH
    assert data["new"]
    for row in data["new"]:
        if row["valid"]:
            assert row["string"] == f"{row['account']}.{row['user']}", row["note"]
        else:
            assert row["note"]


# --- e2e: the harness boots every topology ---------------------------------


@pytest.mark.asyncio
async def test_nkey_noaccounts_alice_authenticates_and_anonymous_is_refused(
    nats_server_nkey: RunningServer, connect_nkey_user: ConnectNkeyUser
) -> None:
    alice = await connect_nkey_user(nats_server_nkey, "alice")

    async def echo(msg: Msg) -> None:
        await msg.respond(msg.data)

    await alice.subscribe("fixture.echo", cb=echo)
    reply = await alice.request("fixture.echo", b"hi", timeout=REQUEST_TIMEOUT_S)
    assert reply.data == b"hi"

    with pytest.raises(nats.errors.Error):
        await nats.connect(nats_server_nkey.url, allow_reconnect=False)


@pytest.mark.asyncio
async def test_nkey_deny_sys_reports_a_permissions_violation_to_error_cb(
    nc_alice_deny_sys: DenySysClient, request: pytest.FixtureRequest
) -> None:
    client = nc_alice_deny_sys
    await client.nc.publish("$SYS.REQ.USER.INFO", b"")
    await client.nc.flush()

    deadline = time.monotonic() + REQUEST_TIMEOUT_S
    while not client.errors and time.monotonic() < deadline:
        await asyncio.sleep(0.02)

    _evidence(request).write_json(
        "violation.json",
        {"errors": [str(e) for e in client.errors], "last_error": str(client.nc.last_error)},
    )
    assert client.errors, "no error reached error_cb — is the deny in the config?"
    # nats-py lower-cases the server's -ERR text before wrapping it
    # ('nats: permissions violation for publish to "$sys.req.user.info"').
    violation = str(client.errors[0]).lower()
    assert "permissions violation for publish" in violation
    assert '"$sys.req.user.info"' in violation
    assert client.nc.last_error is client.errors[0]
    # Not fatal: the connection stays usable.
    assert not client.nc.is_closed


@pytest.mark.asyncio
async def test_accounts_conf_all_users_connect_and_the_acme_export_reaches_every_import(
    nc_alice: NATSClient,
    nc_bob: NATSClient,
    nc_carol: NATSClient,
    nc_dave: NATSClient,
    nc_erin: NATSClient,
    request: pytest.FixtureRequest,
) -> None:
    arrivals: list[str] = []

    async def responder(msg: Msg) -> None:
        arrivals.append(msg.subject)
        await msg.respond(f"alice saw {msg.subject}".encode())

    await nc_alice.subscribe("agents.>", cb=responder)
    await nc_alice.flush()

    async def ask(nc: NATSClient, subject: str) -> str:
        return (await nc.request(subject, b"", timeout=REQUEST_TIMEOUT_S)).data.decode()

    expected = "alice saw agents.prompt.a.o.n"
    assert await ask(nc_carol, "agents.prompt.a.o.n") == expected, "carol, same account"
    assert await ask(nc_bob, "agents.prompt.a.o.n") == expected, "bob (APP), share: true"
    assert await ask(nc_dave, "agents.prompt.a.o.n") == expected, "dave (APP2), no share"
    # erin (APP3) publishes the renamed local subject; alice receives the exporter's.
    assert await ask(nc_erin, "local.agents.prompt.a.o.n") == expected, "erin (APP3), to:"
    _evidence(request).write_json("arrivals.json", arrivals)


@pytest.mark.asyncio
async def test_account_token_position_inserts_the_callers_account_token(
    nats_server_atp: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    request: pytest.FixtureRequest,
) -> None:
    alice = await connect_nkey_user(nats_server_atp, "alice")
    bob = await connect_nkey_user(nats_server_atp, "bob")
    dave = await connect_nkey_user(nats_server_atp, "dave")

    async def responder(msg: Msg) -> None:
        await msg.respond(msg.subject.encode())

    await alice.subscribe("svc.*.prompt", cb=responder)
    await alice.flush()

    async def arrival(nc: NATSClient, subject: str) -> str:
        return (await nc.request(subject, b"", timeout=REQUEST_TIMEOUT_S)).data.decode()

    observed = {
        "bob svc.prompt (to: svc.prompt)": await arrival(bob, "svc.prompt"),
        "bob svc.APP.prompt (plain import)": await arrival(bob, "svc.APP.prompt"),
        "dave svc.APP2.prompt": await arrival(dave, "svc.APP2.prompt"),
    }
    _evidence(request).write_json("arrival-subjects.json", observed)
    assert observed == {
        "bob svc.prompt (to: svc.prompt)": "svc.APP.prompt",
        "bob svc.APP.prompt (plain import)": "svc.APP.prompt",
        "dave svc.APP2.prompt": "svc.APP2.prompt",
    }


@pytest.mark.asyncio
async def test_jetstream_server_comes_up_on_a_throwaway_store_dir(
    nats_server_js: RunningServer,
) -> None:
    assert nats_server_js.store_dir is not None
    assert nats_server_js.store_dir.is_dir()
    nc = await nats.connect(nats_server_js.url)
    try:
        info = await nc.jetstream().account_info()
        assert info.streams == 0
    finally:
        await nc.close()


def test_start_server_fails_fast_on_a_rejected_config(tmp_path: Path) -> None:
    if find_nats_server() is None:
        pytest.skip("nats-server not on PATH")
    bad = tmp_path / "bad.conf"
    bad.write_text('authorization { users: [ { nkey: "NOTAKEY" } ] }\n', encoding="utf-8")
    started = time.monotonic()
    expected = r"exited before listening[\s\S]*Not a valid public nkey"
    with pytest.raises(RuntimeError, match=expected):
        start_server(tmp_path / "logs", config_path=bad)
    assert time.monotonic() - started < FAST_FAIL_BUDGET_S

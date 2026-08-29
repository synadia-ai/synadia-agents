"""Stored mode over JetStream.

``publish_signed`` into a stream (``Nats-Msg-Id`` = nonce); a consumer
verifies the header against the *stored* subject with
``verify_sender(msg, "stored")`` — freshness skipped, identity proven.
The stream's de-duplication window catches a copy inside the window; a
copy after it verifies too and is only caught by consumer-side
``(user, nonce)`` dedupe (documented). A client-set ``Nats-Request-Info``
is not stored. Renamed-import variant: the stored subject is the
exporter's, so the caller signs it (``sub``).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import TYPE_CHECKING

import nats
import pytest
import pytest_asyncio
from nats.js.api import StreamConfig

from synadia_ai.agents import (
    NATS_MSG_ID_HEADER,
    AgentId,
    Agents,
    Identity,
    SenderVerificationError,
    VerifiedSender,
    signer_from_seed,
    verify_sender,
)
from tests.harness.nats_server import find_nats_server, identity_fixture, start_server

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.conftest import EvidenceFor, NkeyUser
    from tests.harness.nats_server import RunningServer

EVIDENCE_ROOT = Path(__file__).parent / "_evidence"
DUPE_WINDOW_S = 1.0


@pytest.fixture(scope="module")
def js_nkey_server() -> Iterator[RunningServer]:
    """``nkey-noaccounts.conf`` with JetStream (``-js -sd``): an identity *and* streams."""
    if find_nats_server() is None:
        pytest.skip("nats-server not on PATH")
    server = start_server(
        EVIDENCE_ROOT / "_nats-server-logs",
        config_path=identity_fixture("nkey-noaccounts.conf"),
        jetstream=True,
    )
    try:
        yield server
    finally:
        server.stop()


@pytest_asyncio.fixture
async def alice_js(
    js_nkey_server: RunningServer, identity_keys: dict[str, NkeyUser]
) -> AsyncIterator[NATSClient]:
    nc = await nats.connect(js_nkey_server.url, nkeys_seed_str=identity_keys["alice"].seed)
    try:
        yield nc
    finally:
        await nc.close()


async def _read_all(nc: NATSClient, stream: str, subject: str, *, expected: int) -> list[Msg]:
    """Read every record of ``stream`` once it holds at least ``expected`` of them.

    A core publish into a stream is stored *after* the server processed
    the PUB, so the publisher's ``flush()`` does not prove the record is
    in the stream yet — wait on the stream's own count (CI caught the
    cross-account variant reading one record of two).
    """
    js = nc.jetstream()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 5.0
    while (count := int((await js.stream_info(stream)).state.messages)) < expected:
        if loop.time() >= deadline:
            raise AssertionError(f"stream {stream} holds {count} records, expected {expected}")
        await asyncio.sleep(0.02)
    sub = await js.pull_subscribe(subject, stream=stream)
    out: list[Msg] = []
    try:
        while len(out) < count:
            for msg in await sub.fetch(count - len(out), timeout=2.0):
                out.append(msg)
                await msg.ack()
    finally:
        await sub.unsubscribe()
    return out


async def test_publish_signed_stores_a_verifiable_record(
    alice_js: NATSClient, identity_keys: dict[str, NkeyUser], evidence_for: EvidenceFor
) -> None:
    alice = identity_keys["alice"]
    recorder = await evidence_for(alice_js)
    js = alice_js.jetstream()
    await js.add_stream(
        StreamConfig(name="IDENT", subjects=["js.identity.>"], duplicate_window=DUPE_WINDOW_S)
    )
    agents = Agents(
        nc=alice_js, identity=Identity(signer=signer_from_seed(alice.seed), name="publisher")
    )
    payload = b'{"event":"hello"}'
    await agents.publish_signed("js.identity.a", payload)
    await alice_js.flush()

    stored = await _read_all(alice_js, "IDENT", "js.identity.>", expected=1)
    assert len(stored) == 1
    first = stored[0]
    sender = verify_sender(first, "stored")
    assert isinstance(sender, VerifiedSender)
    assert sender.id == AgentId.new("$G", alice.public) and sender.name == "publisher"
    assert first.headers is not None and first.headers[NATS_MSG_ID_HEADER] == sender.header.nonce
    assert first.subject == "js.identity.a"

    # Same headers (same Nats-Msg-Id) republished inside the window: not stored.
    dupe = dict(first.headers)
    await alice_js.publish("js.identity.a", payload, headers=dupe)
    await alice_js.flush()
    await asyncio.sleep(0.1)
    assert (await js.stream_info("IDENT")).state.messages == 1

    # After the window the copy is stored and verifies: stored mode proves authorship
    # of content, not uniqueness — consumers dedupe on (user, nonce).
    await asyncio.sleep(DUPE_WINDOW_S + 0.3)
    await alice_js.publish("js.identity.a", payload, headers=dupe)
    await alice_js.flush()
    stored = await _read_all(alice_js, "IDENT", "js.identity.>", expected=2)
    assert len(stored) == 2
    second = verify_sender(stored[1], "stored")
    assert isinstance(second, VerifiedSender) and second.header.nonce == sender.header.nonce

    # A client-set Nats-Request-Info is not stored, even same-account.
    value = await agents.sign_sender("js.identity.b", b"x")
    await alice_js.publish(
        "js.identity.b",
        b"x",
        headers={"Agent-Sender": value, "Nats-Request-Info": '{"acc":"FAKE"}'},
    )
    # A tampered payload fails stored-mode verification.
    value_c = await agents.sign_sender("js.identity.c", b"original")
    await alice_js.publish("js.identity.c", b"tampered", headers={"Agent-Sender": value_c})
    await alice_js.flush()
    stored = await _read_all(alice_js, "IDENT", "js.identity.>", expected=4)
    b = next(m for m in stored if m.subject == "js.identity.b")
    assert b.headers is not None and "Nats-Request-Info" not in b.headers
    assert isinstance(verify_sender(b, "stored"), VerifiedSender)
    c = next(m for m in stored if m.subject == "js.identity.c")
    with pytest.raises(SenderVerificationError) as exc_info:
        verify_sender(c, "stored")
    assert exc_info.value.code == 401
    recorder.write_jsonl(
        "stored.jsonl",
        [{"subject": m.subject, "headers": m.headers, "data": m.data.decode()} for m in stored],
    )
    await agents.close()


# --- renamed import: the stored subject is the exporter's ---------------------


@pytest.fixture(scope="module")
def js_accounts_server(
    tmp_path_factory: pytest.TempPathFactory, identity_keys: dict[str, NkeyUser]
) -> Iterator[RunningServer]:
    """Test-local config: per-account JetStream and a `js.>` service export renamed on import.

    Not a shared fixture — ``accounts.conf`` exports ``agents.>`` / ``$SRV.>``
    only, and JetStream must be enabled per account (PR-T1 decision).
    """
    if find_nats_server() is None:
        pytest.skip("nats-server not on PATH")
    conf = tmp_path_factory.mktemp("js-accounts") / "js-accounts.conf"
    conf.write_text(
        "\n".join(
            [
                "accounts {",
                "  ACME {",
                "    jetstream: enabled",
                f'    users: [ {{ nkey: "{identity_keys["alice"].public}" }} ]',
                '    exports: [ { service: "js.>" } ]',
                "  }",
                "  APP {",
                f'    users: [ {{ nkey: "{identity_keys["bob"].public}" }} ]',
                "    imports: [",
                '      { service: { account: ACME, subject: "js.>" }, to: "local.js.>" }',
                "    ]",
                "  }",
                "}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    server = start_server(EVIDENCE_ROOT / "_nats-server-logs", config_path=conf, jetstream=True)
    try:
        yield server
    finally:
        server.stop()


async def test_renamed_import_signs_the_exporters_subject(
    js_accounts_server: RunningServer, identity_keys: dict[str, NkeyUser]
) -> None:
    alice = await nats.connect(js_accounts_server.url, nkeys_seed_str=identity_keys["alice"].seed)
    bob = await nats.connect(js_accounts_server.url, nkeys_seed_str=identity_keys["bob"].seed)
    try:
        await alice.jetstream().add_stream(StreamConfig(name="RENAMED", subjects=["js.identity.>"]))
        agents = Agents(
            nc=bob, identity=Identity(signer=signer_from_seed(identity_keys["bob"].seed))
        )
        payload = b"from APP"
        await agents.publish_signed("local.js.identity.b", payload, sub="js.identity.b")
        await agents.publish_signed("local.js.identity.naive", payload)
        await bob.flush()
        stored = await _read_all(alice, "RENAMED", "js.identity.>", expected=2)
        assert [m.subject for m in stored] == ["js.identity.b", "js.identity.naive"]
        good = verify_sender(stored[0], "stored")
        assert isinstance(good, VerifiedSender)
        assert good.id == AgentId.new("APP", identity_keys["bob"].public)
        with pytest.raises(SenderVerificationError, match="arrival subject"):
            verify_sender(stored[1], "stored")
        await agents.close()
    finally:
        await alice.close()
        await bob.close()

"""``sign_sender`` / ``publish_signed`` / ``request_signed``, and ``account_token_position``.

The ``account-token-position.conf`` rows are the ScratchPad shape (plan
§2.3b): a hand-rolled responder on ``svc.*.prompt`` verifies with
``account_token_position=2`` — the arrival subject carries the caller's
account token the server inserted; ``sub`` is what the caller published.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from nats.errors import NoRespondersError

from synadia_ai.agents import (
    NATS_MSG_ID_HEADER,
    AgentId,
    Agents,
    Identity,
    SenderSignatureRequiredError,
    VerifiedSender,
    format_sender,
    parse_sender_header,
    serialize_sender_header,
    sign_sender_header,
    signer_from_seed,
    verify_sender,
    verify_sender_header,
)
from tests.harness.fake_agent import FakePromptAgent

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser, EvidenceFor, NkeyUser
    from tests.harness.nats_server import RunningServer

PAYLOAD = b'{"prompt":"hi"}'


async def test_sign_sender_and_publish_signed(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    alice = identity_keys["alice"]
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    agents = Agents(nc=nc, identity=Identity(signer=signer_from_seed(alice.seed), name="pub"))
    alice_id = AgentId.new("$G", alice.public)

    value = await agents.sign_sender("events.a", PAYLOAD)
    header = parse_sender_header(value)
    assert header is not None and header.sub == "events.a" and header.name == "pub"
    assert isinstance(
        verify_sender_header(header, "events.a", PAYLOAD, mode="live"), VerifiedSender
    )
    # `sub` override: signs the exporter's subject, not the publish subject.
    renamed = parse_sender_header(await agents.sign_sender("local.events.a", "x", sub="events.a"))
    assert renamed is not None and renamed.sub == "events.a"
    assert isinstance(
        verify_sender_header(renamed, "events.a", b"x", mode="stored"), VerifiedSender
    )

    events = await nc.subscribe("events.>")
    await nc.flush()
    await agents.publish_signed("events.b", b"hello", headers={"X-Extra": "1"})
    msg = await events.next_msg(timeout=2.0)
    sender = verify_sender(msg, "live")
    assert isinstance(sender, VerifiedSender) and sender.id == alice_id
    assert msg.headers is not None
    assert msg.headers["X-Extra"] == "1"
    assert msg.headers[NATS_MSG_ID_HEADER] == sender.header.nonce

    # No signer → SenderSignatureRequiredError, before any publish.
    plain = Agents(nc=nc, identity=Identity())
    with pytest.raises(SenderSignatureRequiredError):
        await plain.sign_sender("events.c", b"x")
    with pytest.raises(SenderSignatureRequiredError):
        await plain.publish_signed("events.c", b"x")
    with pytest.raises(SenderSignatureRequiredError):
        await plain.request_signed("events.c", b"x")
    await nc.flush()
    with pytest.raises(TimeoutError):
        await events.next_msg(timeout=0.2)  # nothing was published
    await agents.close()
    await plain.close()


async def test_request_signed_is_a_single_reply_request(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    alice = identity_keys["alice"]
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")

    async def responder(msg: Msg) -> None:
        sender = verify_sender(msg, "live")
        await host.publish(
            msg.reply,
            format_sender(sender).encode(),
            headers={"Echo-Msg-Id": (msg.headers or {}).get(NATS_MSG_ID_HEADER, "")},
        )

    await host.subscribe("svc.once", cb=responder)
    await host.flush()
    agents = Agents(nc=caller, identity=Identity(signer=signer_from_seed(alice.seed)))
    reply = await agents.request_signed("svc.once", "payload", timeout_s=2.0)
    assert reply.data.decode() == f"$G.{alice.public} (verified user, claimed account)"
    assert reply.headers is not None and len(reply.headers["Echo-Msg-Id"]) == 22
    assert reply.subject.startswith("_INBOX.agents.")  # the SDK inbox, not nats-py's
    # No interest at all → the server's 503 → NoRespondersError; a responder that
    # never answers → TimeoutError.
    with pytest.raises(NoRespondersError):
        await agents.request_signed("svc.nobody", b"x", timeout_s=1.0)

    async def mute(_msg: Msg) -> None:
        return None

    await host.subscribe("svc.silent", cb=mute)
    await host.flush()
    with pytest.raises(TimeoutError):
        await agents.request_signed("svc.silent", b"x", timeout_s=0.3)
    await agents.close()


# --- account_token_position (account-token-position.conf) ---------------------


async def test_account_token_position_rows(
    nats_server_atp: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    alice = await connect_nkey_user(nats_server_atp, "alice")
    bob = await connect_nkey_user(nats_server_atp, "bob")
    dave = await connect_nkey_user(nats_server_atp, "dave")
    recorder = await evidence_for(alice)
    # A hand-rolled service on `svc.*.prompt` (AgentService cannot host a six-token
    # inserted subject, plan §2.3b) classifying with account_token_position=2.
    svc = await FakePromptAgent(alice, "svc.*.prompt", account_token_position=2).start()

    def agents_for(nc: NATSClient, name: str) -> Agents:
        return Agents(nc=nc, identity=Identity(signer=signer_from_seed(identity_keys[name].seed)))

    def verified_line(account: str, name: str) -> str:
        return f"{account}.{identity_keys[name].public} (verified user, claimed account)"

    async def raw(nc: NATSClient, subject: str, headers: dict[str, str]) -> Msg:
        return await nc.request(subject, PAYLOAD, timeout=2.0, headers=headers)

    def code(msg: Msg) -> str | None:
        return (msg.headers or {}).get("Nats-Service-Error-Code")

    # bob signs what he publishes (`svc.prompt`, import with `to`): arrival `svc.APP.prompt`.
    reply = await agents_for(bob, "bob").request_signed("svc.prompt", PAYLOAD)
    assert code(reply) is None
    assert svc.seen[-1].subject == "svc.APP.prompt"
    assert str(svc.seen[-1].sender) == verified_line("APP", "bob")
    # bob via the plain import signs the token-bearing subject: equality branch.
    reply = await agents_for(bob, "bob").request_signed("svc.APP.prompt", PAYLOAD)
    assert code(reply) is None and str(svc.seen[-1].sender) == verified_line("APP", "bob")
    # A forged account → 401 (the inserted token disagrees).
    forged = await sign_sender_header(
        signer=signer_from_seed(identity_keys["bob"].seed),
        id=AgentId.new("EVIL", identity_keys["bob"].public),
        sub="svc.prompt",
        payload=PAYLOAD,
    )
    assert (
        code(await raw(bob, "svc.prompt", {"Agent-Sender": serialize_sender_header(forged)}))
        == "401"
    )
    # dave (APP2, no share) publishes `svc.APP2.prompt` → verified.
    reply = await agents_for(dave, "dave").request_signed("svc.APP2.prompt", PAYLOAD)
    assert code(reply) is None and str(svc.seen[-1].sender) == verified_line("APP2", "dave")
    # An open endpoint: a same-account ACME user publishing `svc.EVIL.prompt` with account
    # EVIL verifies (documented precondition; account_attested stays False).
    evil = await sign_sender_header(
        signer=signer_from_seed(identity_keys["alice"].seed),
        id=AgentId.new("EVIL", identity_keys["alice"].public),
        sub="svc.EVIL.prompt",
        payload=PAYLOAD,
    )
    assert (
        code(await raw(alice, "svc.EVIL.prompt", {"Agent-Sender": serialize_sender_header(evil)}))
        is None
    )
    assert str(svc.seen[-1].sender) == verified_line("EVIL", "alice")
    # Position 5 on a 3-token arrival subject → 401, never an index error.
    ok = await sign_sender_header(
        signer=signer_from_seed(identity_keys["bob"].seed),
        id=AgentId.new("APP", identity_keys["bob"].public),
        sub="svc.prompt",
        payload=PAYLOAD,
    )
    reply = await raw(
        bob, "svc.prompt", {"Agent-Sender": serialize_sender_header(ok), "X-Test-Position": "5"}
    )
    assert code(reply) == "401"
    recorder.write_jsonl(
        "seen.jsonl",
        [{"subject": s.subject, "sender": str(s.sender), "error": str(s.error)} for s in svc.seen],
    )
    await svc.stop()

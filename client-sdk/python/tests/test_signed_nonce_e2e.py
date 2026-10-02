"""``publish_signed`` / ``sign_sender`` / ``request_signed`` with a caller-chosen nonce.

A message whose body carries its own id signs with that id: it is the
``Agent-Sender`` nonce and the ``Nats-Msg-Id`` as well, so a reader
de-duplicating on ``(user, nonce)`` and a stream de-duplicating on the
message id see one message once. A nonce outside the header grammar is
refused before anything is signed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from synadia_ai.agents import (
    NATS_MSG_ID_HEADER,
    Agents,
    Identity,
    IdentityError,
    VerifiedSender,
    parse_sender_header,
    read_sender_header_value,
    signer_from_seed,
    verify_sender,
)

if TYPE_CHECKING:
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser, EvidenceFor, NkeyUser
    from tests.harness.nats_server import RunningServer


async def test_the_nonce_signs_and_is_the_message_id(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    recorder = await evidence_for(nc)
    agents = Agents(nc=nc, identity=Identity(signer=signer_from_seed(identity_keys["alice"].seed)))
    sub = await nc.subscribe("signed.nonce")
    await nc.flush()
    try:
        await agents.publish_signed("signed.nonce", b"body", nonce="record-1_A")
        msg: Msg = await sub.next_msg(timeout=2.0)
    finally:
        await sub.unsubscribe()
    headers = msg.headers or {}
    recorder.write_json("message.json", {"subject": msg.subject, "headers": dict(headers)})
    header = parse_sender_header(read_sender_header_value(headers) or "")
    assert header is not None and header.nonce == "record-1_A"
    assert headers.get(NATS_MSG_ID_HEADER) == "record-1_A"
    assert isinstance(verify_sender(msg, "stored"), VerifiedSender)

    value = await agents.sign_sender("signed.nonce", b"body", nonce="other")
    parsed = parse_sender_header(value)
    assert parsed is not None and parsed.nonce == "other"

    async def echo(req: Msg) -> None:
        # Answer with the Nats-Msg-Id the request carried.
        await nc.publish(req.reply, b"", headers=dict(req.headers or {}))

    responder = await nc.subscribe("signed.request", cb=echo)
    await nc.flush()
    try:
        reply = await agents.request_signed("signed.request", b"q", nonce="req-1")
    finally:
        await responder.unsubscribe()
    assert (reply.headers or {}).get(NATS_MSG_ID_HEADER) == "req-1"
    await agents.close()


@pytest.mark.parametrize("nonce", ["", "has space", "x" * 65, "dot.ted", "line\n"])
async def test_a_nonce_outside_the_header_grammar_is_refused(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    nonce: str,
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    agents = Agents(nc=nc, identity=Identity(signer=signer_from_seed(identity_keys["alice"].seed)))
    with pytest.raises(IdentityError, match="nonce must match"):
        await agents.publish_signed("signed.nonce", b"body", nonce=nonce)
    with pytest.raises(IdentityError, match="nonce must match"):
        await agents.sign_sender("signed.nonce", b"body", nonce=nonce)
    await agents.close()

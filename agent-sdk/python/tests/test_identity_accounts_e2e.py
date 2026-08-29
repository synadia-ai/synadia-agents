"""T2-T4 through ``AgentService`` on ``accounts.conf``: operator-attested mode and ``resolve()``.

carol (ACME) hosts with ``operator_attested=True``: the deployment
"closed" the endpoint, and for the test ACME's own users play the
forgers. bob (APP, ``share: true``) arrives with the server's full stamp,
dave (APP2, no ``share``) with ``acc`` only, alice (ACME) with none, erin
(APP3) through a renaming import. A second carol service without the
mode shows the stamp is otherwise never read. The host's log is asserted
for the disagreeing field, which never reaches the wire.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

import pytest
from synadia_ai.agents import (
    AgentId,
    Agents,
    DiscoverFilter,
    Envelope,
    HeartbeatPayload,
    Identity,
    ProtocolError,
    ResponseChunk,
    VerifiedSender,
    format_sender,
    serialize_sender_header,
    sign_sender_header,
    signer_from_seed,
)

from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg
    from synadia_ai.agents import Agent, AgentInfo, SenderInfo, StreamMessage

    from tests.conftest import EvidenceFor, NkeyUser

PAYLOAD = b'{"prompt":"hi"}'
IDENTITY_LOGGER = "synadia_ai.agent_service.identity"
ERROR_FRAMES = 2


class Seen:
    def __init__(self) -> None:
        self.senders: list[SenderInfo | None] = []
        self.resolved: list[AgentInfo | None] = []


async def _host(
    nc: NATSClient, *, agent: str, session_name: str, signer_seed: str, **overrides: object
) -> tuple[AgentService, Seen]:
    seen = Seen()
    service = AgentService(
        agent=agent,
        owner="acme",
        session_name=session_name,
        nc=nc,
        heartbeat_interval_s=1,
        keepalive_interval_s=None,
        identity=ServiceIdentity(signer=signer_from_seed(signer_seed)),
        **overrides,  # type: ignore[arg-type]
    )

    async def handler(_envelope: Envelope, stream: PromptStream) -> None:
        s = stream.sender
        seen.senders.append(s)
        seen.resolved.append(await s.resolve() if isinstance(s, VerifiedSender) else None)
        await stream.send(format_sender(s))

    service.on_prompt(handler)
    await service.start()
    return service, seen


async def _drain(stream: AsyncIterator[StreamMessage]) -> list[StreamMessage]:
    return [m async for m in stream]


def _echo(events: list[StreamMessage]) -> str:
    return next(m.text for m in events if isinstance(m, ResponseChunk))


async def _raw_prompt(
    nc: NATSClient, subject: str, payload: bytes, headers: dict[str, str] | None = None
) -> list[Msg]:
    inbox = nc.new_inbox()
    sub = await nc.subscribe(inbox)
    await nc.publish(subject, payload, reply=inbox, headers=headers)
    out: list[Msg] = []
    while True:
        msg = await sub.next_msg(timeout=3.0)
        out.append(msg)
        if msg.data == b"" and not msg.headers:
            break
    await sub.unsubscribe()
    return out


def _error(msgs: list[Msg]) -> tuple[str | None, str | None]:
    h = msgs[0].headers or {}
    return (h.get("Nats-Service-Error-Code"), h.get("Nats-Service-Error"))


async def _agent_for(nc: NATSClient, user: NkeyUser, agent: str) -> tuple[Agents, Agent]:
    agents = Agents(nc=nc, identity=Identity(signer=signer_from_seed(user.seed), name=user.name))
    found = await agents.discover(timeout=1.0, filter=DiscoverFilter(agent=agent))
    assert len(found) == 1, f"{agent} not discovered from {user.name}: {found!r}"
    return agents, found[0]


async def test_operator_attested_host_across_accounts(  # noqa: PLR0915 — one topology, one walk
    nc_alice: NATSClient,
    nc_bob: NATSClient,
    nc_carol: NATSClient,
    nc_dave: NATSClient,
    nc_erin: NATSClient,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
    caplog: pytest.LogCaptureFixture,
) -> None:
    recorder = await evidence_for(nc_carol)
    alice, bob, dave, erin = (identity_keys[n] for n in ("alice", "bob", "dave", "erin"))
    host, seen = await _host(
        nc_carol,
        agent="acme-svc",
        session_name="attested",
        signer_seed=identity_keys["carol"].seed,
        operator_attested=True,
    )
    # alice (ACME) registers her own service with a signer → her ID resolves.
    alice_svc, _ = await _host(
        nc_alice, agent="alice-svc", session_name="own", signer_seed=alice.seed
    )
    try:
        assert host.operator_attested is True
        assert host.identity == AgentId.new("ACME", identity_keys["carol"].public)

        # T3 — bob (APP, share: true): the server stamp agrees → attested, `(verified)`;
        # resolve() → None (APP's registrations are invisible from ACME).
        agents, agent = await _agent_for(nc_bob, bob, "acme-svc")
        events = await _drain(agent.prompt("hi"))
        bob_id = AgentId.new("APP", bob.public)
        assert _echo(events) == f"{bob_id} (verified)"
        s = seen.senders[-1]
        assert isinstance(s, VerifiedSender)
        assert s.id == bob_id and s.account_attested is True and s.name == "bob"
        assert seen.resolved[-1] is None
        # `request_signed` (single reply) reaches the status endpoint through the export;
        # the host classifies the prober (nonce into the shared set) and answers.
        reply = await agents.request_signed(host.subject.status, b"")
        assert HeartbeatPayload.model_validate_json(reply.data).instance_id == host.instance_id
        await agents.close()

        # T2 — alice (ACME, same account, no stamp): verified, account NOT attested;
        # resolve() → alice's own AgentService registration.
        agents, agent = await _agent_for(nc_alice, alice, "acme-svc")
        events = await _drain(agent.prompt("hi"))
        alice_id = AgentId.new("ACME", alice.public)
        assert _echo(events) == f"{alice_id} (verified user, claimed account)"
        s = seen.senders[-1]
        assert isinstance(s, VerifiedSender) and s.id == alice_id and not s.account_attested
        resolved = seen.resolved[-1]
        assert resolved is not None
        assert resolved.identity == alice_id and resolved.id_sig_verified is True
        assert resolved.instance_id == alice_svc.instance_id
        assert resolved.prompt_endpoint.subject == alice_svc.subject.prompt
        await agents.close()

        # T4 — dave (APP2, no share): `acc` only in the stamp → still attested
        # (account attestation is about `acc`; `user` is the signature's).
        agents, agent = await _agent_for(nc_dave, dave, "acme-svc")
        events = await _drain(agent.prompt("hi"))
        dave_id = AgentId.new("APP2", dave.public)
        assert _echo(events) == f"{dave_id} (verified)"
        s = seen.senders[-1]
        assert isinstance(s, VerifiedSender) and s.id == dave_id and s.account_attested is True
        await agents.close()

        # T3 remapped — erin (APP3, `to: local.agents.>`): publish the local name, sign
        # the exporter's subject; the stamp (APP3) agrees → attested.
        agents, agent = await _agent_for(nc_erin, erin, "acme-svc")
        local = f"local.{host.subject.prompt}"
        events = await _drain(agent.prompt("hi", subject=local, sub=host.subject.prompt))
        erin_id = AgentId.new("APP3", erin.public)
        assert _echo(events) == f"{erin_id} (verified)"
        s = seen.senders[-1]
        assert isinstance(s, VerifiedSender) and s.id == erin_id and s.account_attested is True
        # Signing the local name instead → 401 with the generic description.
        with pytest.raises(ProtocolError, match="service error 401: sender rejected"):
            await _drain(agent.prompt("hi", subject=local))
        await agents.close()

        # A forged Nats-Request-Info from a same-account user → 401 `sender rejected`,
        # before the ack; the disagreeing field goes to the log only.
        h = await sign_sender_header(
            signer=signer_from_seed(alice.seed),
            id=alice_id,
            sub=host.subject.prompt,
            payload=PAYLOAD,
        )
        forged = {
            "Agent-Sender": serialize_sender_header(h),
            "Nats-Request-Info": json.dumps({"acc": "APP", "user": bob.public}),
        }
        before = len(seen.senders)
        with caplog.at_level(logging.WARNING, logger=IDENTITY_LOGGER):
            msgs = await _raw_prompt(nc_alice, host.subject.prompt, PAYLOAD, forged)
            assert len(msgs) == ERROR_FRAMES
            assert _error(msgs) == ("401", "sender rejected")
            # A stamp the server would not write → 401 too.
            h2 = await sign_sender_header(
                signer=signer_from_seed(alice.seed),
                id=alice_id,
                sub=host.subject.prompt,
                payload=PAYLOAD,
            )
            junk = {"Agent-Sender": serialize_sender_header(h2), "Nats-Request-Info": "{"}
            assert (
                _error(await _raw_prompt(nc_alice, host.subject.prompt, PAYLOAD, junk))[0] == "401"
            )
        assert len(seen.senders) == before
        assert any("acc 'APP' disagrees" in r.getMessage() for r in caplog.records)
        assert any("not a server stamp" in r.getMessage() for r in caplog.records)

        recorder.write_jsonl("senders.jsonl", [str(s) for s in seen.senders])
    finally:
        await alice_svc.stop()
        await host.stop()


async def test_without_operator_attested_the_stamp_is_never_read(
    nc_alice: NATSClient,
    nc_bob: NATSClient,
    nc_carol: NATSClient,
    identity_keys: dict[str, NkeyUser],
) -> None:
    alice, bob = identity_keys["alice"], identity_keys["bob"]
    host, seen = await _host(
        nc_carol, agent="acme-open", session_name="open", signer_seed=identity_keys["carol"].seed
    )
    try:
        assert host.operator_attested is False
        # bob's genuine server stamp: verified, but the account stays a claim.
        agents, agent = await _agent_for(nc_bob, bob, "acme-open")
        assert _echo(await _drain(agent.prompt("hi"))) == (
            f"{AgentId.new('APP', bob.public)} (verified user, claimed account)"
        )
        await agents.close()
        # alice's forged stamp passes verbatim and is ignored by the SDK.
        alice_id = AgentId.new("ACME", alice.public)
        h = await sign_sender_header(
            signer=signer_from_seed(alice.seed),
            id=alice_id,
            sub=host.subject.prompt,
            payload=PAYLOAD,
        )
        forged = {"Agent-Sender": serialize_sender_header(h), "Nats-Request-Info": '{"acc":"EVIL"}'}
        msgs = await _raw_prompt(nc_alice, host.subject.prompt, PAYLOAD, forged)
        assert _error(msgs) == (None, None)
        s = seen.senders[-1]
        assert isinstance(s, VerifiedSender) and s.id == alice_id and not s.account_attested
    finally:
        await host.stop()

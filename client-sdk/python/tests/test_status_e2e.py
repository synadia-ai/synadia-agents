"""``Agent.status()`` — the §8.7 probe with an ``Agent-Sender`` header attached."""

from __future__ import annotations

from types import MappingProxyType
from typing import TYPE_CHECKING

import nats
import pytest
from nats.errors import NoRespondersError

from synadia_ai.agents import (
    Agent,
    AgentId,
    AgentInfo,
    ClaimedSender,
    EndpointInfo,
    HeartbeatPayload,
    Identity,
    NatsAgentError,
    ProtocolError,
    VerifiedSender,
    signer_from_seed,
)
from synadia_ai.agents.identity._nkeys import SHA256_EMPTY_HEX
from tests.harness.fake_agent import FakeStatusAgent

if TYPE_CHECKING:
    from tests.conftest import ConnectNkeyUser, EvidenceFor, NkeyUser
    from tests.harness.nats_server import RunningServer

PROMPT_SUBJECT = "agents.prompt.status-ref.testers.main"
STATUS_SUBJECT = "agents.status.status-ref.testers.main"


def _info(with_status: bool = True) -> AgentInfo:
    prompt = EndpointInfo(
        name="prompt",
        subject=PROMPT_SUBJECT,
        queue_group="agents",
        metadata=MappingProxyType({"min_sender_trust": "any"}),
        attachments_ok=True,
    )
    endpoints: tuple[EndpointInfo, ...] = (prompt,)
    if with_status:
        endpoints += (EndpointInfo(name="status", subject=STATUS_SUBJECT, queue_group="agents"),)
    return AgentInfo(
        instance_id="i",
        agent="status-ref",
        owner="testers",
        session_name="main",
        protocol_version="0.3",
        description="",
        version="0.0.0",
        metadata=MappingProxyType({}),
        endpoints=endpoints,
        prompt_endpoint=prompt,
        supports_sender_identity=True,
    )


async def test_status_carries_a_verified_header_over_an_empty_payload(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    alice = identity_keys["alice"]
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")
    recorder = await evidence_for(caller)
    fake = await FakeStatusAgent(host, STATUS_SUBJECT, instance_id="inst-42").start()
    agent = Agent(
        caller, _info(), identity=Identity(signer=signer_from_seed(alice.seed), name="probe")
    )
    hb = await agent.status()
    assert isinstance(hb, HeartbeatPayload)
    assert hb.instance_id == "inst-42"
    seen = fake.seen[-1]
    assert seen.data == b""
    assert isinstance(seen.sender, VerifiedSender)
    assert seen.sender.id == AgentId.new("$G", alice.public)
    assert seen.sender.header.sub == STATUS_SUBJECT
    assert seen.sender.name == "probe"
    recorder.write_json("status.json", {"header": seen.header, "sha256_empty": SHA256_EMPTY_HEX})
    # Without a signer: a claim; the probe is answered all the same.
    hb = await Agent(caller, _info(), identity=Identity()).status()
    assert hb.instance_id == "inst-42"
    assert isinstance(fake.seen[-1].sender, ClaimedSender)
    # Replaying a captured status header: the receiver's classification fails (recorded),
    # but the probe is still answered — `status` never rejects on identity grounds.
    await fake.stop()


async def test_status_errors(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")
    identity = Identity(signer=signer_from_seed(identity_keys["alice"].seed))
    with pytest.raises(NatsAgentError, match="declares no status endpoint"):
        await Agent(caller, _info(with_status=False), identity=identity).status()
    # No responder at all → NoRespondersError (the server's 503).
    with pytest.raises(NoRespondersError):
        await Agent(caller, _info(), identity=identity).status(timeout_s=1.0)
    # An explicit subject override reaches a responder the record does not list.
    fake = await FakeStatusAgent(host, "agents.status.status-ref.testers.alt").start()
    hb = await Agent(caller, _info(with_status=False), identity=identity).status(
        subject="agents.status.status-ref.testers.alt"
    )
    assert hb.instance_id == fake.instance_id
    await fake.stop()
    # An error-headered reply → ProtocolError with the code.
    failing = await FakeStatusAgent(host, STATUS_SUBJECT, error_code=500).start()
    with pytest.raises(ProtocolError, match="service error 500"):
        await Agent(caller, _info(), identity=identity).status()
    await failing.stop()
    # A reply that is not a heartbeat payload → ProtocolError.
    junk = await FakeStatusAgent(host, STATUS_SUBJECT, reply=b'{"nope":1}').start()
    with pytest.raises(ProtocolError, match="heartbeat payload"):
        await Agent(caller, _info(), identity=identity).status()
    await junk.stop()


async def test_status_on_a_no_auth_server_sends_no_header(nats_server: RunningServer) -> None:
    host = await nats.connect(nats_server.url)
    caller = await nats.connect(nats_server.url)
    try:
        fake = await FakeStatusAgent(host, STATUS_SUBJECT).start()
        hb = await Agent(caller, _info(), identity=Identity(name="x")).status()
        assert hb.agent == "fake"
        assert fake.seen[-1].header is None and fake.seen[-1].sender is None
        await fake.stop()
    finally:
        await host.close()
        await caller.close()

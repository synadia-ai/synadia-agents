"""``Agent.prompt()`` with sender identity over real brokers (T0 / T1 caller side, T2-T4).

The receiving side is the fake agent in ``tests/harness/fake_agent.py``:
it classifies every request with the *shared* ``verify_sender`` (the
codec PR-P2's host will call), records the verdict and answers §6 chunks
— so what these tests assert is what the shared verifier decided over
the header the caller actually put on the wire. The evidence
``messages.jsonl`` of each test holds the raw ``Agent-Sender`` values.
"""

from __future__ import annotations

import json
from types import MappingProxyType
from typing import TYPE_CHECKING

import nats
import pytest

from synadia_ai.agents import (
    Agent,
    AgentId,
    AgentInfo,
    Agents,
    ClaimedSender,
    EndpointInfo,
    Identity,
    IdentityError,
    IdentityMismatchError,
    NoIdentityError,
    PayloadTooLargeError,
    ProtocolError,
    ResponseChunk,
    SenderSignatureRequiredError,
    StatusChunk,
    VerifiedSender,
    max_sender_header_bytes,
    serialize_sender_header,
    sign_sender_header,
    signer_from_seed,
)
from synadia_ai.agents.identity import USER_INFO_SUBJECT, encoded_header_length
from tests.harness.fake_agent import FakePromptAgent, FakeStatusAgent

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from synadia_ai.agents import StreamMessage
    from synadia_ai.agents.identity import NkeySigner
    from tests.conftest import ConnectNkeyUser, EvidenceFor, NkeyUser
    from tests.harness.nats_server import RunningServer

PROMPT_SUBJECT = "agents.prompt.t1-ref.testers.main"
OTHER_SUBJECT = "agents.prompt.t1-ref.testers.other"
NAME_CAP = 64
PAYLOAD = b'{"prompt":"hi"}'


def _info(
    subject: str,
    *,
    min_sender_trust: str | None = "any",
    max_payload_bytes: int | None = None,
    status_subject: str | None = None,
) -> AgentInfo:
    """A hand-built record (the test owns both ends; no ``$SRV.INFO`` round trip)."""
    md: dict[str, str] = {}
    if min_sender_trust is not None:
        md["min_sender_trust"] = min_sender_trust
    prompt = EndpointInfo(
        name="prompt",
        subject=subject,
        queue_group="agents",
        metadata=MappingProxyType(md),
        max_payload_bytes=max_payload_bytes,
        attachments_ok=True,
        min_sender_trust="signed" if min_sender_trust == "signed" else "any",
    )
    endpoints: tuple[EndpointInfo, ...] = (prompt,)
    if status_subject is not None:
        endpoints += (EndpointInfo(name="status", subject=status_subject, queue_group="agents"),)
    return AgentInfo(
        instance_id="test-instance",
        agent="t1-ref",
        owner="testers",
        session_name="main",
        protocol_version="0.3",
        description="",
        version="0.0.0",
        metadata=MappingProxyType({"agent": "t1-ref", "owner": "testers"}),
        endpoints=endpoints,
        prompt_endpoint=prompt,
        supports_sender_identity=min_sender_trust is not None,
    )


async def _drain(stream: AsyncIterator[StreamMessage]) -> list[StreamMessage]:
    return [m async for m in stream]


async def _raw_prompt(
    nc: NATSClient, subject: str, payload: bytes, headers: dict[str, str] | None = None
) -> list[Msg]:
    """Publish a request by hand and collect the reply frames up to the terminator."""
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


def _error_code(msgs: list[Msg]) -> str | None:
    return (msgs[0].headers or {}).get("Nats-Service-Error-Code") if msgs else None


@pytest.fixture
def alice_signer(identity_keys: dict[str, NkeyUser]) -> NkeySigner:
    return signer_from_seed(identity_keys["alice"].seed)


@pytest.fixture
def alice_id(identity_keys: dict[str, NkeyUser]) -> AgentId:
    return AgentId.new("$G", identity_keys["alice"].public)


# --- T1: nkey user, no accounts ($G) ------------------------------------------


async def test_t1_signed_prompts_verify_with_fresh_nonces(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    alice_signer: NkeySigner,
    alice_id: AgentId,
    evidence_for: EvidenceFor,
) -> None:
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")
    recorder = await evidence_for(caller)
    fake = await FakePromptAgent(host, PROMPT_SUBJECT).start()
    agent = Agent(
        caller, _info(PROMPT_SUBJECT), identity=Identity(signer=alice_signer, name="claude-code")
    )
    for i in range(2):
        events = await _drain(agent.prompt(f"hi {i}"))
        assert [m.text for m in events if isinstance(m, ResponseChunk)] == ["ok"]
    assert len(fake.seen) == 2
    for seen in fake.seen:
        assert isinstance(seen.sender, VerifiedSender), seen.error
        assert seen.sender.id == alice_id
        assert seen.sender.account_attested is False
        assert seen.sender.name == "claude-code"
        assert seen.sender.header.sub == PROMPT_SUBJECT
        assert seen.header is not None
    assert fake.seen[0].sender is not None and fake.seen[1].sender is not None
    assert fake.seen[0].sender.header.nonce != fake.seen[1].sender.header.nonce
    recorder.write_jsonl(
        "seen.jsonl", [{"header": s.header, "sender": str(s.sender)} for s in fake.seen]
    )
    await fake.stop()


async def test_t1_unsigned_claim_by_default_and_none_when_disabled(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")
    fake = await FakePromptAgent(host, PROMPT_SUBJECT).start()
    await _drain(
        Agent(caller, _info(PROMPT_SUBJECT), identity=Identity(name="claimant")).prompt("hi")
    )
    claim = fake.seen[-1].sender
    assert isinstance(claim, ClaimedSender)
    assert not hasattr(claim, "id")
    assert claim.claim.account == "$G" and claim.claim.user == identity_keys["alice"].public
    assert claim.name == "claimant"
    assert str(claim) == f"$G.{identity_keys['alice'].public} (claimed)"

    silent = Identity(send_unsigned_claim=False)
    await _drain(Agent(caller, _info(PROMPT_SUBJECT), identity=silent).prompt("hi"))
    assert fake.seen[-1].header is None and fake.seen[-1].sender is None
    # A handle built without an identity at all sends nothing either.
    await _drain(Agent(caller, _info(PROMPT_SUBJECT)).prompt("hi"))
    assert fake.seen[-1].header is None and fake.seen[-1].sender is None
    await fake.stop()


async def test_t1_signed_endpoint_rules(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    alice_signer: NkeySigner,
    alice_id: AgentId,
) -> None:
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")
    fake = await FakePromptAgent(host, PROMPT_SUBJECT, min_sender_trust="signed").start()
    info = _info(PROMPT_SUBJECT, min_sender_trust="signed")
    # No signer → raised at call time, before any wire I/O.
    with pytest.raises(SenderSignatureRequiredError):
        Agent(caller, info, identity=Identity()).prompt("hi")
    with pytest.raises(SenderSignatureRequiredError):
        Agent(caller, info).prompt("hi")
    assert fake.seen == []
    # Signed → served.
    events = await _drain(Agent(caller, info, identity=Identity(signer=alice_signer)).prompt("hi"))
    assert any(isinstance(m, ResponseChunk) for m in events)
    assert isinstance(fake.seen[-1].sender, VerifiedSender)
    # A raw unsigned request → 401 "signature required" + terminator; a claim → 401 too.
    msgs = await _raw_prompt(caller, PROMPT_SUBJECT, PAYLOAD)
    assert _error_code(msgs) == "401"
    assert (
        msgs[0].headers is not None
        and msgs[0].headers["Nats-Service-Error"] == "signature required"
    )
    assert msgs[-1].data == b"" and not msgs[-1].headers
    claim = json.dumps({"v": 1, "account": "$G", "user": alice_id.user}, separators=(",", ":"))
    assert (
        _error_code(await _raw_prompt(caller, PROMPT_SUBJECT, PAYLOAD, {"Agent-Sender": claim}))
        == "401"
    )
    # Through the SDK the 401 surfaces as the usual service error.
    with pytest.raises(ProtocolError, match="service error 401: signature required"):
        await _drain(Agent(caller, _info(PROMPT_SUBJECT), identity=Identity()).prompt("hi"))
    await fake.stop()


async def test_t1_mismatched_signer_rejects_on_first_iteration(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")  # fresh: memo is per connection
    fake = await FakePromptAgent(host, PROMPT_SUBJECT).start()
    bob = Identity(signer=signer_from_seed(identity_keys["bob"].seed))
    stream = Agent(caller, _info(PROMPT_SUBJECT), identity=bob).prompt("hi")  # no raise yet
    with pytest.raises(IdentityMismatchError):
        await _drain(stream)
    assert fake.seen == []
    await fake.stop()


async def test_t1_codec_outcomes_on_the_wire(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    alice_signer: NkeySigner,
    alice_id: AgentId,
) -> None:
    """Replay / transplant / malformed / unknown v / header case, decided by the shared verifier."""
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")
    a = await FakePromptAgent(host, PROMPT_SUBJECT).start()
    b = await FakePromptAgent(host, OTHER_SUBJECT).start()
    h = await sign_sender_header(
        signer=alice_signer, id=alice_id, sub=PROMPT_SUBJECT, payload=PAYLOAD
    )
    value = serialize_sender_header(h)
    assert (
        _error_code(await _raw_prompt(caller, PROMPT_SUBJECT, PAYLOAD, {"Agent-Sender": value}))
        is None
    )
    assert isinstance(a.seen[-1].sender, VerifiedSender)
    # Replay (same nonce, same user) → 401 sender rejected.
    replay = await _raw_prompt(caller, PROMPT_SUBJECT, PAYLOAD, {"Agent-Sender": value})
    assert _error_code(replay) == "401"
    assert (
        replay[0].headers is not None
        and replay[0].headers["Nats-Service-Error"] == "sender rejected"
    )
    # Transplanted verbatim onto another subject → 401.
    assert (
        _error_code(await _raw_prompt(caller, OTHER_SUBJECT, PAYLOAD, {"Agent-Sender": value}))
        == "401"
    )
    assert b.seen[-1].sender is None and b.seen[-1].error is not None
    # Malformed → 400.
    assert (
        _error_code(await _raw_prompt(caller, PROMPT_SUBJECT, PAYLOAD, {"Agent-Sender": "{"}))
        == "400"
    )
    # Unknown v → served with no sender.
    v2 = json.dumps({**json.loads(value), "v": 2}, separators=(",", ":"))
    assert (
        _error_code(await _raw_prompt(caller, PROMPT_SUBJECT, PAYLOAD, {"Agent-Sender": v2}))
        is None
    )
    assert a.seen[-1].sender is None and a.seen[-1].error is None
    # Lowercase header name → absent (nats-py preserves header-name case).
    fresh = await sign_sender_header(
        signer=alice_signer, id=alice_id, sub=PROMPT_SUBJECT, payload=PAYLOAD
    )
    lower = {"agent-sender": serialize_sender_header(fresh)}
    assert _error_code(await _raw_prompt(caller, PROMPT_SUBJECT, PAYLOAD, lower)) is None
    assert a.seen[-1].sender is None and "agent-sender" in (a.seen[-1].headers or {})
    await a.stop()
    await b.stop()


async def test_t1_max_payload_counts_the_framed_header(
    nats_server_nkey: RunningServer, connect_nkey_user: ConnectNkeyUser, alice_signer: NkeySigner
) -> None:
    limit = 2048
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")
    fake = await FakePromptAgent(host, PROMPT_SUBJECT).start()
    name = "n" * NAME_CAP
    agent = Agent(
        caller,
        _info(PROMPT_SUBJECT, max_payload_bytes=limit),
        identity=Identity(signer=alice_signer, name=name),
    )
    bound = max_sender_header_bytes(PROMPT_SUBJECT, name)
    fits = "x" * (limit - bound - len('{"prompt":""}'))
    await _drain(agent.prompt(fits))
    assert len(fake.seen) == 1
    assert isinstance(fake.seen[0].sender, VerifiedSender)
    assert fake.seen[0].header is not None
    assert encoded_header_length(fake.seen[0].header) + len(fake.seen[0].data) <= limit
    with pytest.raises(PayloadTooLargeError) as exc_info:
        agent.prompt(fits + "x")  # synchronous: the sound bound
    assert exc_info.value.header_bytes == bound
    assert len(fake.seen) == 1
    await fake.stop()


def test_identity_name_is_validated_at_option_time() -> None:
    with pytest.raises(IdentityError):
        Identity(name="x" * (NAME_CAP + 1))
    with pytest.raises(IdentityError):
        Identity(name="a\nb")
    assert Identity(name="x" * NAME_CAP).name == "x" * NAME_CAP


# --- T0: no auth --------------------------------------------------------------


async def test_t0_no_header_no_sender_lookup_once(
    nats_server: RunningServer, alice_signer: NkeySigner, evidence_for: EvidenceFor
) -> None:
    host = await nats.connect(nats_server.url)
    caller = await nats.connect(nats_server.url)
    try:
        recorder = await evidence_for(caller)
        fake = await FakePromptAgent(host, PROMPT_SUBJECT).start()
        probes: list[Msg] = []

        async def spy(msg: Msg) -> None:
            probes.append(msg)

        await caller.subscribe(USER_INFO_SUBJECT, cb=spy)
        await caller.flush()
        agent = Agent(caller, _info(PROMPT_SUBJECT), identity=Identity(name="x"))
        for i in range(2):
            events = await _drain(agent.prompt(f"hi {i}"))
            assert events[-1] == StatusChunk(status="ack") or any(
                isinstance(m, ResponseChunk) for m in events
            )
        await caller.flush()
        assert len(fake.seen) == 2
        assert all(s.header is None and s.sender is None for s in fake.seen)
        assert len(probes) == 1  # the lookup ran once per connection
        recorder.write_json("probes.json", len(probes))

        # A signer on a no-auth connection: NoIdentityError on the first iteration
        # of a `signed` endpoint (a 0.3-style `any` endpoint just sends no header).
        signed = _info(PROMPT_SUBJECT, min_sender_trust="signed")
        stream = Agent(caller, signed, identity=Identity(signer=alice_signer)).prompt("hi")
        with pytest.raises(NoIdentityError):
            await _drain(stream)
        await _drain(
            Agent(caller, _info(PROMPT_SUBJECT), identity=Identity(signer=alice_signer)).prompt(
                "hi"
            )
        )
        assert fake.seen[-1].header is None
        await fake.stop()
    finally:
        await host.close()
        await caller.close()


# --- T2 / T3 / T4: accounts.conf ----------------------------------------------


ACME_PROMPT = "agents.prompt.acme-agent.acme.main"
ACME_STATUS = "agents.status.acme-agent.acme.main"
SIBLING_PROMPT = "agents.prompt.acme-agent.acme.sibling"


async def _agents_for(nc: NATSClient, user: NkeyUser) -> Agents:
    return Agents(nc=nc, identity=Identity(signer=signer_from_seed(user.seed), name=user.name))


async def test_accounts_same_and_cross_account_signing(  # noqa: PLR0915 — one topology, one walk
    nc_alice: NATSClient,
    nc_bob: NATSClient,
    nc_carol: NATSClient,
    nc_dave: NATSClient,
    nc_erin: NATSClient,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    recorder = await evidence_for(nc_carol)
    host = await FakePromptAgent(nc_carol, ACME_PROMPT, chunks=("one", "two", "three")).start()
    status_host = await FakeStatusAgent(nc_carol, ACME_STATUS).start()
    sibling = await FakePromptAgent(nc_carol, SIBLING_PROMPT).start()

    def agent(nc: NATSClient, user: NkeyUser) -> Agent:
        identity = Identity(signer=signer_from_seed(user.seed), name=user.name)
        return Agent(nc, _info(ACME_PROMPT, status_subject=ACME_STATUS), identity=identity)

    # T2 same account: alice → carol's agent.
    alice = identity_keys["alice"]
    assert await Agents(
        nc=nc_alice, identity=Identity(signer=signer_from_seed(alice.seed))
    ).self_id() == (AgentId.new("ACME", alice.public))
    events = await _drain(agent(nc_alice, alice).prompt("hi"))
    assert [m.text for m in events if isinstance(m, ResponseChunk)] == ["one", "two", "three"]
    seen = host.seen[-1]
    assert isinstance(seen.sender, VerifiedSender)
    assert seen.sender.id == AgentId.new("ACME", alice.public) and not seen.sender.account_attested
    # A forged Nats-Request-Info from the same account passes verbatim and is ignored by the SDK.
    h = await sign_sender_header(
        signer=signer_from_seed(alice.seed),
        id=AgentId.new("ACME", alice.public),
        sub=ACME_PROMPT,
        payload=PAYLOAD,
    )
    forged = {"Agent-Sender": serialize_sender_header(h), "Nats-Request-Info": '{"acc":"EVIL"}'}
    assert _error_code(await _raw_prompt(nc_alice, ACME_PROMPT, PAYLOAD, forged)) is None
    assert host.seen[-1].request_info is not None and "EVIL" in host.seen[-1].request_info
    assert isinstance(host.seen[-1].sender, VerifiedSender)

    # T3 cross-account with share: bob (APP).
    bob = identity_keys["bob"]
    events = await _drain(agent(nc_bob, bob).prompt("hi"))
    assert [m.text for m in events if isinstance(m, ResponseChunk)] == ["one", "two", "three"]
    seen = host.seen[-1]
    assert isinstance(seen.sender, VerifiedSender)
    assert seen.sender.id == AgentId.new("APP", bob.public) and seen.sender.name == "bob"
    assert seen.request_info is not None
    stamp = json.loads(seen.request_info)
    assert stamp["acc"] == "APP" and stamp["user"] == bob.public  # the server's stamp
    assert str(seen.sender) == f"APP.{bob.public} (verified user, claimed account)"
    hb = await agent(nc_bob, bob).status()
    assert hb.instance_id == status_host.instance_id
    assert isinstance(status_host.seen[-1].sender, VerifiedSender)

    # T4 cross-account without share: dave (APP2) — acc only in the stamp.
    dave = identity_keys["dave"]
    await _drain(agent(nc_dave, dave).prompt("hi"))
    seen = host.seen[-1]
    assert isinstance(seen.sender, VerifiedSender)
    assert seen.sender.id == AgentId.new("APP2", dave.public)
    assert seen.request_info is not None and "user" not in json.loads(seen.request_info)

    # T3 remapped import (erin, APP3): publish the local name, sign the exporter's subject.
    erin = identity_keys["erin"]
    local = f"local.{ACME_PROMPT}"
    events = await _drain(agent(nc_erin, erin).prompt("hi", subject=local, sub=ACME_PROMPT))
    assert [m.text for m in events if isinstance(m, ResponseChunk)] == ["one", "two", "three"]
    seen = host.seen[-1]
    assert isinstance(seen.sender, VerifiedSender)
    assert seen.sender.id == AgentId.new("APP3", erin.public)
    assert seen.sender.header.sub == ACME_PROMPT
    # Signing the local name instead → 401 with the generic description.
    with pytest.raises(ProtocolError, match="service error 401: sender rejected"):
        await _drain(agent(nc_erin, erin).prompt("hi", subject=local))
    # A header signed for the sibling's subject re-presented here → 401.
    for_sibling = await sign_sender_header(
        signer=signer_from_seed(erin.seed),
        id=AgentId.new("APP3", erin.public),
        sub=SIBLING_PROMPT,
        payload=PAYLOAD,
    )
    assert (
        _error_code(
            await _raw_prompt(
                nc_erin, local, PAYLOAD, {"Agent-Sender": serialize_sender_header(for_sibling)}
            )
        )
        == "401"
    )
    assert sibling.seen == []
    # Without an override the discovered subject has no interest in APP3 → not served.
    before = len(host.seen)
    with pytest.raises(ProtocolError):
        await _drain(agent(nc_erin, erin).prompt("hi"))
    assert len(host.seen) == before
    # status() takes the same overrides.
    hb = await agent(nc_erin, erin).status(subject=f"local.{ACME_STATUS}", sub=ACME_STATUS)
    assert hb.instance_id == status_host.instance_id
    assert isinstance(status_host.seen[-1].sender, VerifiedSender)
    assert status_host.seen[-1].sender.id == AgentId.new("APP3", erin.public)

    recorder.write_jsonl(
        "seen.jsonl",
        [
            {"subject": s.subject, "sender": str(s.sender), "request_info": s.request_info}
            for s in host.seen
        ],
    )
    await host.stop()
    await status_host.stop()
    await sibling.stop()

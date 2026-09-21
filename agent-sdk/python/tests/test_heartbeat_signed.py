"""The ``Agent-Sender`` header on a heartbeat.

To a receiver that requires signed heartbeats, an agent's presence is its
signed heartbeat: with a signer the publisher sets the header of the
sender-identity extension, unchanged, on every beat — ``sub`` the
heartbeat subject as published, ``ts`` the frame's own ``ts``, a fresh
nonce per beat, ``sig`` over subject · ts · nonce · sha256 of the exact
bytes published. Without a signer the beat
goes out bare, as protocol 0.3. Checked against the shared known-answer
vector (``test-fixtures/identity/sender-vectors.json``,
``signed-heartbeat``) byte for byte, with the SDK's own verifier over the
wire, and through ``AgentService`` on an nkey server.
"""

from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import pytest
from synadia_ai.agents import (
    AGENT_SENDER_HEADER,
    AgentId,
    AgentSubject,
    Envelope,
    HeartbeatPayload,
    SenderVerificationError,
    VerifiedSender,
    signer_from_seed,
    verify_sender,
)

from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agent_service.heartbeat import (
    HeartbeatSigner,
    publish_one,
    run_publisher,
    sign_heartbeat,
)
from tests.harness.nats_server import identity_fixture

if TYPE_CHECKING:
    from collections.abc import Mapping

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser, NkeyUser
    from tests.harness.nats_server import RunningServer

AGENT = "hb-signed"
OWNER = "pytest-hb"
INSTANCE_ID = "hb-signed-instance-A"
NUID_LENGTH = 22

VECTORS: dict[str, Any] = json.loads(
    identity_fixture("sender-vectors.json").read_text(encoding="utf-8")
)
VECTOR: dict[str, Any] = next(v for v in VECTORS["vectors"] if v["id"] == "signed-heartbeat")


@dataclass(frozen=True, slots=True)
class _Msg:
    """A message as the verifier sees it: arrival subject, bytes, headers."""

    subject: str
    data: bytes
    headers: Mapping[str, object] | None


def _alice_signer(identity_keys: dict[str, NkeyUser]) -> HeartbeatSigner:
    alice = identity_keys["alice"]
    return HeartbeatSigner(
        id=AgentId.new("$G", alice.public),
        signer=signer_from_seed(alice.seed),
    )


def _verified(msg: Msg | _Msg, *, seen: set[str] | None = None) -> VerifiedSender:
    """Verify a heartbeat as a live consumer would; ``seen`` is that consumer's nonce set."""
    nonces = set() if seen is None else seen
    sender = verify_sender(msg, "live", nonce_seen=lambda user, nonce: f"{user}.{nonce}" in nonces)
    assert isinstance(sender, VerifiedSender), sender
    header = sender.header
    assert header.nonce is not None
    nonces.add(f"{header.user}.{header.nonce}")
    return sender


async def _echo(envelope: Envelope, stream: PromptStream) -> None:
    await stream.send(envelope.prompt)


# --- the known-answer vector ----------------------------------------------


def test_vector_signs_the_heartbeat_subject_and_the_frames_own_ts() -> None:
    frame = json.loads(base64.b64decode(VECTOR["input"]["payload_b64"]))
    assert VECTOR["input"]["subject"] == "agents.hb.demo-agent.alice.example"
    assert frame["ts"] == VECTOR["input"]["ts"]


async def test_vector_reproduced_byte_for_byte() -> None:
    inp, exp = VECTOR["input"], VECTOR["expected"]
    sender = HeartbeatSigner(
        id=AgentId.new(inp["account"], inp["user"]), signer=signer_from_seed(inp["seed"])
    )
    data = base64.b64decode(inp["payload_b64"])
    frame = json.loads(data)
    headers = await sign_heartbeat(sender, inp["subject"], data, frame["ts"], nonce=inp["nonce"])
    assert headers == {AGENT_SENDER_HEADER: exp["header"]}
    assert len(exp["header"].encode("utf-8")) == exp["header_bytes"]
    # Stored mode: the vector's ts is fixed in the past.
    verified = verify_sender(_Msg(inp["subject"], data, headers), "stored")
    assert isinstance(verified, VerifiedSender)
    assert verified.id == sender.id
    assert verified.header.sub == inp["subject"]
    assert verified.header.ts == frame["ts"]


# --- the publisher ---------------------------------------------------------


async def test_publish_one_signs_when_a_signer_is_held(
    nc: NATSClient, identity_keys: dict[str, NkeyUser]
) -> None:
    sender = _alice_signer(identity_keys)
    subject = AgentSubject.new(agent=AGENT, owner=OWNER, session_name="one-signed")
    sub = await nc.subscribe(subject.heartbeat)
    try:
        await publish_one(nc, subject, interval_s=5, instance_id=INSTANCE_ID, sender=sender)
        msg = await sub.next_msg(timeout=1.0)
    finally:
        await sub.unsubscribe()

    # The frame is the plain §8.3 one; only the header is new.
    payload = HeartbeatPayload.model_validate_json(msg.data)
    assert payload.instance_id == INSTANCE_ID
    assert msg.headers is not None and list(msg.headers) == [AGENT_SENDER_HEADER]

    verified = _verified(msg)
    assert verified.id == sender.id
    assert verified.header.sub == msg.subject == subject.heartbeat
    assert verified.header.ts == payload.ts
    assert verified.header.name is None
    assert verified.header.nonce is not None and len(verified.header.nonce) == NUID_LENGTH


async def test_publish_one_beats_bare_without_a_signer(nc: NATSClient) -> None:
    subject = AgentSubject.new(agent=AGENT, owner=OWNER, session_name="one-bare")
    sub = await nc.subscribe(subject.heartbeat)
    try:
        await publish_one(nc, subject, interval_s=5, instance_id=INSTANCE_ID)
        msg = await sub.next_msg(timeout=1.0)
    finally:
        await sub.unsubscribe()
    assert not msg.headers
    assert verify_sender(msg, "live") is None


async def test_signed_frame_rejects_tampering_and_transplant(
    nc: NATSClient, identity_keys: dict[str, NkeyUser]
) -> None:
    sender = _alice_signer(identity_keys)
    subject = AgentSubject.new(agent=AGENT, owner=OWNER, session_name="one-tamper")
    sub = await nc.subscribe(subject.heartbeat)
    try:
        await publish_one(nc, subject, interval_s=5, instance_id=INSTANCE_ID, sender=sender)
        msg = await sub.next_msg(timeout=1.0)
    finally:
        await sub.unsubscribe()
    _verified(msg)
    tampered = msg.data.replace(b'"interval_s":5', b'"interval_s":6')
    assert tampered != msg.data
    with pytest.raises(SenderVerificationError):
        verify_sender(_Msg(msg.subject, tampered, msg.headers), "live")
    other = AgentSubject.new(agent=AGENT, owner=OWNER, session_name="other").heartbeat
    with pytest.raises(SenderVerificationError):
        verify_sender(_Msg(other, msg.data, msg.headers), "live")


async def test_run_publisher_signs_every_beat_with_a_fresh_nonce(
    nc: NATSClient, identity_keys: dict[str, NkeyUser]
) -> None:
    sender = _alice_signer(identity_keys)
    subject = AgentSubject.new(agent=AGENT, owner=OWNER, session_name="loop-signed")
    sub = await nc.subscribe(subject.heartbeat)
    stop = asyncio.Event()
    task = asyncio.create_task(
        run_publisher(nc, subject, 1, INSTANCE_ID, stop, sender=sender),
        name="hb-test-signed-loop",
    )
    try:
        first = await sub.next_msg(timeout=1.0)
        second = await sub.next_msg(timeout=2.0)
    finally:
        stop.set()
        await task
        await sub.unsubscribe()
    seen: set[str] = set()
    for msg in (first, second):
        verified = _verified(msg, seen=seen)
        assert verified.header.ts == HeartbeatPayload.model_validate_json(msg.data).ts
    assert len(seen) == 2


async def test_extras_fallback_keeps_the_signature(
    nc: NATSClient, identity_keys: dict[str, NkeyUser]
) -> None:
    """A rejected extra costs the beat its extras, never its signature."""
    sender = _alice_signer(identity_keys)
    subject = AgentSubject.new(agent=AGENT, owner=OWNER, session_name="loop-fallback")
    sub = await nc.subscribe(subject.heartbeat)
    stop = asyncio.Event()
    task = asyncio.create_task(
        run_publisher(
            nc, subject, 10, INSTANCE_ID, stop, extras=lambda: {"agent": "forged"}, sender=sender
        ),
        name="hb-test-signed-fallback",
    )
    try:
        msg = await sub.next_msg(timeout=1.0)
    finally:
        stop.set()
        await task
        await sub.unsubscribe()
    assert HeartbeatPayload.model_validate_json(msg.data).agent == AGENT
    _verified(msg)


# --- through AgentService --------------------------------------------------


async def _first_beat_and_status(service: AgentService, probe: NATSClient) -> tuple[Msg, Msg, str]:
    """Start ``service``, take its first beat and one status reply, stop it.

    Returns the instance id as well: it is only known while the service runs.
    """
    sub = await probe.subscribe(service.subject.heartbeat)
    await probe.flush()
    await service.start()
    try:
        beat = await sub.next_msg(timeout=2.0)
        status = await probe.request(service.subject.status, b"", timeout=2.0)
        return beat, status, service.instance_id
    finally:
        await sub.unsubscribe()
        await service.stop()


async def test_service_signs_its_heartbeats_with_the_id_sig_signer(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    alice = identity_keys["alice"]
    host = await connect_nkey_user(nats_server_nkey, "alice")
    probe = await connect_nkey_user(nats_server_nkey, "alice")
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="service-signed",
        nc=host,
        heartbeat_interval_s=1,
        identity=ServiceIdentity(signer=signer_from_seed(alice.seed)),
    )
    service.on_prompt(_echo)
    beat, status, instance_id = await _first_beat_and_status(service, probe)

    assert service.identity == AgentId.new("$G", alice.public)
    payload = HeartbeatPayload.model_validate_json(beat.data)
    assert payload.instance_id == instance_id
    verified = _verified(beat)
    assert verified.id == service.identity
    assert verified.header.sub == beat.subject == service.subject.heartbeat
    assert verified.header.ts == payload.ts
    # The status reply builds the same frame but is not a heartbeat: no header.
    assert HeartbeatPayload.model_validate_json(status.data).instance_id == instance_id
    assert verify_sender(status, "live") is None


async def test_service_with_an_unsigned_registration_beats_bare(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    alice = identity_keys["alice"]
    host = await connect_nkey_user(nats_server_nkey, "alice")
    probe = await connect_nkey_user(nats_server_nkey, "alice")
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="service-claimed",
        nc=host,
        heartbeat_interval_s=1,
        identity=ServiceIdentity(),
    )
    service.on_prompt(_echo)
    beat, status, _ = await _first_beat_and_status(service, probe)
    assert service.identity == AgentId.new("$G", alice.public)
    for msg in (beat, status):
        assert verify_sender(msg, "live") is None


async def test_service_without_host_identity_beats_bare(nc: NATSClient) -> None:
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="service-plain",
        nc=nc,
        heartbeat_interval_s=1,
    )
    service.on_prompt(_echo)
    beat, status, _ = await _first_beat_and_status(service, nc)
    assert service.identity is None
    for msg in (beat, status):
        assert verify_sender(msg, "live") is None

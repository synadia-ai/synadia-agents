"""Registration metadata of the sender-identity extension, read back from ``$SRV.INFO``.

``AgentService.start()`` registers ``user_nkey`` / ``account`` whenever
the connection has an NKEY identity, ``id_sig`` (``AGENT-ID-V1`` over the
prompt subject) only with a signer, and **always** ``min_sender_trust``
on the prompt endpoint — never on ``status``. The evidence of each test
is the raw ``$SRV.INFO`` reply (``srv-info.json``); the assertions run
the shared verifier (``verify_agent_id``) and the client-side discovery
over it.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

import nats
import pytest
from synadia_ai.agents import (
    AgentId,
    Agents,
    DiscoverFilter,
    Envelope,
    IdentityMismatchError,
    IdentityUnavailableError,
    signer_from_seed,
    verify_agent_id,
)
from synadia_ai.agents.identity import IDENTITY_METADATA_KEYS

from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.conftest import ConnectNkeyUser, DenySysClient, EvidenceFor, NkeyUser
    from tests.harness.nats_server import RunningServer

AGENT = "reg-id"
OWNER = "pytest-reg"
SERVICE_LOGGER = "synadia_ai.agent_service.service"


async def _echo(envelope: Envelope, stream: PromptStream) -> None:
    await stream.send(envelope.prompt)


async def _srv_info(nc: NATSClient, prompt_subject: str) -> dict[str, object]:
    """The ``$SRV.INFO`` record of the instance serving ``prompt_subject``."""
    inbox = nc.new_inbox()
    sub = await nc.subscribe(inbox)
    await nc.publish("$SRV.INFO.agents", b"", reply=inbox)
    while True:
        msg = await sub.next_msg(timeout=2.0)
        record: dict[str, object] = json.loads(msg.data)
        endpoints = record["endpoints"]
        assert isinstance(endpoints, list)
        if any(ep["name"] == "prompt" and ep["subject"] == prompt_subject for ep in endpoints):
            await sub.unsubscribe()
            return record


def _endpoint(record: dict[str, object], name: str) -> dict[str, object]:
    endpoints = record["endpoints"]
    assert isinstance(endpoints, list)
    ep = next(e for e in endpoints if e["name"] == name)
    assert isinstance(ep, dict)
    return ep


async def test_signer_registers_user_nkey_account_and_a_verifying_id_sig(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    alice = identity_keys["alice"]
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")
    recorder = await evidence_for(caller)
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="signed",
        nc=host,
        heartbeat_interval_s=1,
        identity=ServiceIdentity(signer=signer_from_seed(alice.seed)),
        min_sender_trust="signed",
    )
    service.on_prompt(_echo)
    assert service.identity is None  # not known before start()
    await service.start()
    try:
        alice_id = AgentId.new("$G", alice.public)
        assert service.identity == alice_id
        assert service.min_sender_trust == "signed"
        assert service.instance_id

        record = await _srv_info(caller, service.subject.prompt)
        recorder.write_json("srv-info.json", record)
        metadata = record["metadata"]
        assert isinstance(metadata, dict)
        assert set(metadata) >= IDENTITY_METADATA_KEYS | {
            "agent",
            "owner",
            "session",
            "protocol_version",
        }
        assert metadata["user_nkey"] == alice.public
        assert metadata["account"] == "$G"
        assert metadata["protocol_version"] == "0.3"  # no protocol bump: feature detection
        # `id_sig` is AGENT-ID-V1 over the prompt endpoint subject — the shared
        # verifier accepts it, and a different subject does not.
        assert verify_agent_id(metadata, service.subject.prompt) is True
        assert verify_agent_id(metadata, service.subject.prompt + ".x") is False

        prompt_ep = _endpoint(record, "prompt")
        prompt_md = prompt_ep["metadata"]
        assert isinstance(prompt_md, dict)
        assert prompt_md["min_sender_trust"] == "signed"
        status_ep = _endpoint(record, "status")
        assert "min_sender_trust" not in (status_ep.get("metadata") or {})

        # The client-side view of the same record.
        agents = Agents(nc=caller)
        try:
            found = await agents.discover(
                timeout=1.0, filter=DiscoverFilter(agent=AGENT, session_name="signed")
            )
            assert len(found) == 1
            info = found[0]
            assert info.identity == alice_id
            assert info.id_sig_verified is True
            assert info.supports_sender_identity is True
            assert info.min_sender_trust == "signed"
            assert info.instance_id == service.instance_id
        finally:
            await agents.close()
    finally:
        await service.stop()


async def test_without_a_signer_the_keys_are_registered_unsigned(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    alice = identity_keys["alice"]
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="unsigned",
        nc=host,
        heartbeat_interval_s=1,
        identity=ServiceIdentity(),
    )
    service.on_prompt(_echo)
    await service.start()
    try:
        assert service.identity == AgentId.new("$G", alice.public)
        record = await _srv_info(caller, service.subject.prompt)
        metadata = record["metadata"]
        assert isinstance(metadata, dict)
        assert metadata["user_nkey"] == alice.public and metadata["account"] == "$G"
        assert "id_sig" not in metadata  # a display-grade claim, per the spec
        prompt_md = _endpoint(record, "prompt")["metadata"]
        assert isinstance(prompt_md, dict) and prompt_md["min_sender_trust"] == "any"
        agents = Agents(nc=caller)
        try:
            found = await agents.discover(
                timeout=1.0, filter=DiscoverFilter(agent=AGENT, session_name="unsigned")
            )
            assert len(found) == 1
            assert found[0].identity == service.identity
            assert found[0].id_sig_verified is False
            assert found[0].supports_sender_identity is True
        finally:
            await agents.close()
    finally:
        await service.stop()


async def test_a_foreign_signer_makes_start_raise_identity_mismatch(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    # Signed host startup binds against the live connection on every attempt;
    # it never reuses the signer-less diagnostic memo.
    host = await connect_nkey_user(nats_server_nkey, "alice")
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="mismatch",
        nc=host,
        heartbeat_interval_s=1,
        identity=ServiceIdentity(signer=signer_from_seed(identity_keys["bob"].seed)),
    )
    service.on_prompt(_echo)
    with pytest.raises(IdentityMismatchError):
        await service.start()
    assert service.identity is None


async def test_t0_omitted_identity_starts_without_lookup_or_identity_metadata(
    nats_server: RunningServer, caplog: pytest.LogCaptureFixture
) -> None:
    host = await nats.connect(nats_server.url)
    caller = await nats.connect(nats_server.url)
    seen: list[object] = ["unset"]

    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        seen[0] = stream.sender
        await stream.send("ok")

    service = AgentService(
        agent=AGENT, owner=OWNER, session_name="t0", nc=host, heartbeat_interval_s=1
    )
    service.on_prompt(handler)
    try:
        with caplog.at_level(logging.WARNING, logger=SERVICE_LOGGER):
            await service.start()
        assert service.identity is None
        assert not any("without identity metadata" in r.getMessage() for r in caplog.records)
        record = await _srv_info(caller, service.subject.prompt)
        metadata = record["metadata"]
        assert isinstance(metadata, dict)
        assert not (set(metadata) & IDENTITY_METADATA_KEYS)
        prompt_md = _endpoint(record, "prompt")["metadata"]
        assert isinstance(prompt_md, dict) and prompt_md["min_sender_trust"] == "any"
        agents = Agents(nc=caller)
        try:
            found = await agents.discover(
                timeout=1.0, filter=DiscoverFilter(agent=AGENT, session_name="t0")
            )
            assert len(found) == 1
            assert found[0].supports_sender_identity is True
            assert found[0].identity is None
            events = [m async for m in found[0].prompt("hi")]
            assert events
            assert seen[0] is None  # header-less request: the harness sees no sender
        finally:
            await agents.close()
    finally:
        await service.stop()
        await host.close()
        await caller.close()


async def test_omitted_identity_works_without_sys_permission_but_signed_host_fails(
    nc_alice_deny_sys: DenySysClient,
    identity_keys: dict[str, NkeyUser],
) -> None:
    host = nc_alice_deny_sys.nc
    before = host.last_error
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="omitted-deny",
        nc=host,
        heartbeat_interval_s=1,
    )
    service.on_prompt(_echo)
    await service.start()
    try:
        await host.flush()
        assert host.last_error is before
        assert nc_alice_deny_sys.errors == []
        record = await _srv_info(host, service.subject.prompt)
        metadata = record["metadata"]
        assert isinstance(metadata, dict)
        assert not (set(metadata) & IDENTITY_METADATA_KEYS)
        assert service.identity is None
    finally:
        await service.stop()

    signed = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="signed-deny",
        nc=host,
        heartbeat_interval_s=1,
        identity=ServiceIdentity(signer=signer_from_seed(identity_keys["alice"].seed)),
    )
    signed.on_prompt(_echo)
    with pytest.raises(IdentityUnavailableError, match="permissions violation"):
        await signed.start()

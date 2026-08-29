"""Discovery over real ``$SRV.INFO`` records with identity metadata, and the reverse lookup."""

from __future__ import annotations

from typing import TYPE_CHECKING

from synadia_ai.agents import (
    AgentId,
    Agents,
    DiscoverFilter,
    Identity,
    SenderResolver,
    signer_from_seed,
)
from synadia_ai.agents.identity import IDENTITY_METADATA_KEYS
from tests.harness.fake_agent import register_agent_service

if TYPE_CHECKING:
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser, EvidenceFor, NkeyUser
    from tests.harness.nats_server import RunningServer


async def test_srv_info_carries_identity_keys_and_id_sig_verifies(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    alice = identity_keys["alice"]
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")
    recorder = await evidence_for(caller)
    signer = signer_from_seed(alice.seed)
    good = await register_agent_service(
        host, agent="disc", owner="testers", session_name="good", signer=signer, account="$G"
    )
    tampered = await register_agent_service(
        host,
        agent="disc",
        owner="testers",
        session_name="tampered",
        signer=signer,
        account="$G",
        tamper_id_sig=True,
    )
    claim_only = await register_agent_service(
        host, agent="disc", owner="testers", session_name="claim", min_sender_trust="signed"
    )
    legacy = await register_agent_service(
        host, agent="disc", owner="testers", session_name="legacy", min_sender_trust=None
    )
    try:
        agents = Agents(nc=caller, identity=Identity(signer=signer))
        found = {
            a.session_name: a
            for a in await agents.discover(timeout=1.0, filter=DiscoverFilter(agent="disc"))
        }
        assert set(found) == {"good", "tampered", "claim", "legacy"}
        recorder.write_json("srv-info.json", {k: dict(a.metadata) for k, a in found.items()})

        g = found["good"]
        assert set(g.metadata) >= IDENTITY_METADATA_KEYS
        assert g.metadata["user_nkey"] == alice.public and g.metadata["account"] == "$G"
        assert g.identity == await agents.self_id() == AgentId.new("$G", alice.public)
        assert g.id_sig_verified is True
        assert g.supports_sender_identity is True and g.min_sender_trust == "any"
        assert g.prompt_endpoint.metadata["min_sender_trust"] == "any"

        assert found["tampered"].identity == g.identity
        assert found["tampered"].id_sig_verified is False

        c = found["claim"]
        assert c.identity is None and c.id_sig_verified is False
        assert c.supports_sender_identity is True and c.min_sender_trust == "signed"

        old = found["legacy"]
        assert old.supports_sender_identity is False and old.min_sender_trust == "any"
        assert old.identity is None

        # The registered service really classifies: a signed prompt lands verified.
        events = [m async for m in g.prompt("hi")]
        assert events
        assert (
            good.seen
            and str(good.seen[-1].sender) == f"{g.identity} (verified user, claimed account)"
        )
        hb = await g.status()
        assert hb.instance_id == good.instance_id
        await agents.close()
    finally:
        for r in (good, tampered, claim_only, legacy):
            await r.stop()


async def test_resolve_sender_indexes_verified_registrations_with_a_ttl_cache(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    alice = identity_keys["alice"]
    host = await connect_nkey_user(nats_server_nkey, "alice")
    caller = await connect_nkey_user(nats_server_nkey, "alice")
    signer = signer_from_seed(alice.seed)
    good = await register_agent_service(
        host, agent="res", owner="testers", session_name="good", signer=signer, account="$G"
    )
    bad = await register_agent_service(
        host,
        agent="res",
        owner="testers",
        session_name="bad",
        signer=signer,
        account="$G",
        tamper_id_sig=True,
    )
    infos: list[Msg] = []

    async def spy(msg: Msg) -> None:
        infos.append(msg)

    await caller.subscribe("$SRV.INFO.agents", cb=spy)
    await caller.flush()
    try:
        alice_id = AgentId.new("$G", alice.public)
        agents = Agents(nc=caller, resolve_ttl_s=10.0)
        info = await agents.resolve_sender(alice_id)
        assert info is not None
        assert (
            info.prompt_endpoint.subject == good.prompt_subject
        )  # the tampered instance is dropped
        assert info.instance_id == good.instance_id
        assert await agents.resolve_sender(str(alice_id)) is not None  # text form accepted
        assert await agents.resolve_sender(AgentId.new("$G", identity_keys["bob"].public)) is None
        await caller.flush()
        assert len(infos) == 1  # three lookups, one enumeration (TTL cache)

        resolver = SenderResolver(caller, ttl_s=0.0)
        assert (await resolver.resolve(alice_id)) is not None
        assert (await resolver.resolve(alice_id)) is not None
        await caller.flush()
        assert len(infos) == 3
        await good.stop()
        resolver.invalidate()
        assert await resolver.resolve(alice_id) is None  # only the tampered one is left
        await agents.close()
    finally:
        await bad.stop()

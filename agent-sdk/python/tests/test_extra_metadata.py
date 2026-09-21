"""``AgentService(extra_metadata=…)``: harness keys in the §3 registration metadata.

Parity with the TypeScript host's ``extraMetadata``, with one deliberate
rule on precedence: the required keys (``agent``, ``owner``, ``session``,
``protocol_version``) and the identity keys always win over an extra
entry. The identity-key half runs against the NKEY server in
``test_registration_identity_e2e.py``; this file covers the required keys
(evidence: ``srv-info.json``) and the constructor's ``str`` checks, which
need no broker.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest
from synadia_ai.agents import Agents, DiscoverFilter, Envelope

from synadia_ai.agent_service import AgentService, PromptStream

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder

AGENT = "extra-md"
OWNER = "pytest-extra"


async def _noop(envelope: Envelope, stream: PromptStream) -> None:
    del envelope, stream


async def _srv_info(nc: NATSClient, prompt_subject: str) -> dict[str, Any]:
    """The ``$SRV.INFO`` record of the instance serving ``prompt_subject``."""
    inbox = nc.new_inbox()
    sub = await nc.subscribe(inbox)
    await nc.publish("$SRV.INFO.agents", b"", reply=inbox)
    while True:
        msg = await sub.next_msg(timeout=2.0)
        record: dict[str, Any] = json.loads(msg.data)
        if any(
            ep["name"] == "prompt" and ep["subject"] == prompt_subject for ep in record["endpoints"]
        ):
            await sub.unsubscribe()
            return record


def _service(extra_metadata: Any) -> AgentService:
    return AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="unit",
        nc=MagicMock(),
        extra_metadata=extra_metadata,
    )


async def test_extra_keys_are_registered_and_required_keys_win(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    extra = {
        "agent": "forged-agent",
        "owner": "forged-owner",
        "session": "forged-session",
        "protocol_version": "9.9",
        "role": "controller",
    }
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="precedence",
        nc=nc,
        heartbeat_interval_s=30,
        extra_metadata=extra,
    )
    # The service holds its own copy: a later mutation of the caller's dict
    # changes nothing that start() registers.
    extra["role"] = "mutated"
    extra["late"] = "added"
    service.on_prompt(_noop)
    await service.start()
    try:
        record = await _srv_info(nc, service.subject.prompt)
        evidence.write_json("srv-info.json", record)
        assert record["metadata"] == {
            "agent": AGENT,
            "owner": OWNER,
            "session": "precedence",
            "protocol_version": "0.3",
            "role": "controller",
        }

        # Discovery filters on the real identifiers, not the forged ones.
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(
                timeout=1.0, filter=DiscoverFilter(agent=AGENT, session_name="precedence")
            )
            assert len(found) == 1
            assert found[0].owner == OWNER
            assert found[0].protocol_version == "0.3"
            assert found[0].metadata["role"] == "controller"
            forged = await agents.discover(timeout=1.0, filter=DiscoverFilter(agent="forged-agent"))
            assert forged == []
        finally:
            await agents.close()
    finally:
        await service.stop()


async def test_omitted_extra_metadata_registers_only_the_required_keys(
    nc: NATSClient,
) -> None:
    service = AgentService(
        agent=AGENT, owner=OWNER, session_name="omitted", nc=nc, heartbeat_interval_s=30
    )
    service.on_prompt(_noop)
    await service.start()
    try:
        record = await _srv_info(nc, service.subject.prompt)
        assert set(record["metadata"]) == {"agent", "owner", "session", "protocol_version"}
    finally:
        await service.stop()


class TestValidation:
    @pytest.mark.parametrize("extra", [None, {}, {"role": "controller", "": ""}])
    def test_accepts_str_to_str_dicts_and_none(self, extra: dict[str, str] | None) -> None:
        _service(extra)

    @pytest.mark.parametrize("extra", [[("role", "controller")], "role=controller"])
    def test_rejects_a_non_dict(self, extra: object) -> None:
        with pytest.raises(TypeError, match=r"extra_metadata must be a dict\[str, str\] or None"):
            _service(extra)

    def test_rejects_a_non_str_key_and_names_it(self) -> None:
        with pytest.raises(TypeError, match=r"extra_metadata key 7 must be a str; got int"):
            _service({"role": "controller", 7: "seven"})

    @pytest.mark.parametrize(
        ("value", "type_name"),
        [(42, "int"), (True, "bool"), (None, "NoneType"), (b"s3cr3t-value", "bytes")],
    )
    def test_rejects_a_non_str_value_and_names_its_key(self, value: object, type_name: str) -> None:
        with pytest.raises(TypeError) as exc_info:
            _service({"role": "controller", "model_size": value})
        message = str(exc_info.value)
        assert message.startswith(f"extra_metadata['model_size'] must be a str; got {type_name}")
        assert "s3cr3t" not in message  # the value itself is never echoed

"""``AGENT-ID-V1`` — known-answer vectors, field order (``user`` first), tampering (unit)."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from synadia_ai.agents import AgentId, sign_agent_id, verify_agent_id
from synadia_ai.agents.identity import (
    AGENT_ID_SIGNED_INPUT_TAG,
    IDENTITY_METADATA_KEYS,
    base64url_decode,
    build_agent_id_signed_input,
    signer_from_seed,
    verify_with_public_key,
)
from tests.harness.nats_server import identity_fixture

if TYPE_CHECKING:
    from tests.conftest import NkeyUser

VECTORS: dict[str, Any] = json.loads(
    identity_fixture("id-sig-vectors.json").read_text(encoding="utf-8")
)
SUBJECT = "agents.prompt.demo.alice.example"


@pytest.mark.parametrize("v", VECTORS["vectors"], ids=[v["id"] for v in VECTORS["vectors"]])
async def test_vector(v: dict[str, Any]) -> None:
    inp, exp = v["input"], v["expected"]
    data = build_agent_id_signed_input(
        user=inp["user"],
        account=inp["account"],
        agent=inp["agent"],
        owner=inp["owner"],
        prompt_subject=inp["prompt_subject"],
    )
    assert data.decode("utf-8") == exp["signed_input"]
    assert verify_with_public_key(inp["user"], data, base64url_decode(exp["id_sig"]))
    assert verify_agent_id(exp["metadata"], inp["prompt_subject"])
    assert not verify_agent_id(exp["metadata"], inp["prompt_subject"] + ".x")
    # Re-signing with the seed reproduces the vector byte for byte (ed25519 is deterministic).
    signer = signer_from_seed(inp["seed"])
    assert signer.public_key == inp["user"]
    produced = await sign_agent_id(
        signer=signer,
        id=AgentId.new(inp["account"], inp["user"]),
        agent=inp["agent"],
        owner=inp["owner"],
        prompt_subject=inp["prompt_subject"],
    )
    assert produced == exp["id_sig"]


def test_signed_input_field_order() -> None:
    data = build_agent_id_signed_input(
        user="U", account="A", agent="ag", owner="ow", prompt_subject="s.u.b"
    )
    assert data == f"{AGENT_ID_SIGNED_INPUT_TAG}\nU\nA\nag\now\ns.u.b\n".encode()
    assert {"user_nkey", "account", "id_sig"} == IDENTITY_METADATA_KEYS


async def _metadata_for(
    alice: NkeyUser, prompt_subject: str, agent: str = "demo", owner: str = "alice"
) -> dict[str, str]:
    signer = signer_from_seed(alice.seed)
    id_sig = await sign_agent_id(
        signer=signer,
        id=AgentId.new("ACME", signer.public_key),
        agent=agent,
        owner=owner,
        prompt_subject=prompt_subject,
    )
    return {
        "agent": agent,
        "owner": owner,
        "protocol_version": "0.3",
        "user_nkey": signer.public_key,
        "account": "ACME",
        "id_sig": id_sig,
    }


async def test_custom_prompt_subject_is_what_is_bound(identity_keys: dict[str, NkeyUser]) -> None:
    alice = identity_keys["alice"]
    assert verify_agent_id(await _metadata_for(alice, SUBJECT), SUBJECT)
    custom = await _metadata_for(alice, "svc.custom.prompt")
    assert verify_agent_id(custom, "svc.custom.prompt")
    assert not verify_agent_id(custom, SUBJECT)


async def test_tampering_and_missing_fields_fail(identity_keys: dict[str, NkeyUser]) -> None:
    m = await _metadata_for(identity_keys["alice"], SUBJECT)
    assert not verify_agent_id({**m, "agent": "other"}, SUBJECT)
    assert not verify_agent_id({**m, "owner": "other"}, SUBJECT)
    assert not verify_agent_id({**m, "account": "$G"}, SUBJECT)
    assert not verify_agent_id({**m, "user_nkey": identity_keys["bob"].public}, SUBJECT)
    assert not verify_agent_id({**m, "id_sig": "AAAA"}, SUBJECT)
    assert not verify_agent_id({**m, "id_sig": "not-base64url!"}, SUBJECT)
    assert not verify_agent_id({**m, "user_nkey": "notakey"}, SUBJECT)
    for key in m:
        if key == "protocol_version":
            continue
        copy = dict(m)
        del copy[key]
        assert not verify_agent_id(copy, SUBJECT), key

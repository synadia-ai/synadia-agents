"""Discovery-side identity fields and the header-inclusive ``max_payload`` check (unit)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from synadia_ai.agents import (
    AgentId,
    IdentityError,
    NatsAgentError,
    PayloadTooLargeError,
    ValidationError,
    build_agent_info,
    parse_min_sender_trust,
    sign_agent_id,
)
from synadia_ai.agents.discovery import _build_endpoint_info
from synadia_ai.agents.identity import signer_from_seed
from synadia_ai.agents.validation import assert_within_max_payload

if TYPE_CHECKING:
    from tests.conftest import NkeyUser

SUBJECT = "agents.prompt.cc.alice.sess-1"


def _info(
    metadata: dict[str, str], endpoint_metadata: dict[str, str] | None = None
) -> dict[str, Any]:
    return {
        "name": "agents",
        "id": "VMKS6MHK71PCPWGY38A7N5",
        "version": "1.0.0",
        "description": "t",
        "metadata": {
            "agent": "claude-code",
            "owner": "alice",
            "protocol_version": "0.3",
            **metadata,
        },
        "endpoints": [
            {
                "name": "prompt",
                "subject": SUBJECT,
                "queue_group": "agents",
                "metadata": {"max_payload": "1MB", **(endpoint_metadata or {})},
            }
        ],
    }


def test_parse_min_sender_trust() -> None:
    assert parse_min_sender_trust(None) == ("any", False)
    assert parse_min_sender_trust("any") == ("any", True)
    assert parse_min_sender_trust("signed") == ("signed", True)
    assert parse_min_sender_trust("verified-plus") == ("signed", True)
    assert parse_min_sender_trust("") == ("signed", True)


def test_min_sender_trust_lands_on_the_prompt_endpoint_only() -> None:
    p = _build_endpoint_info(
        {"name": "prompt", "subject": SUBJECT, "metadata": {"min_sender_trust": "weird"}}
    )
    assert p.min_sender_trust == "signed"
    assert p.metadata["min_sender_trust"] == "weird"
    s = _build_endpoint_info(
        {"name": "status", "subject": SUBJECT, "metadata": {"min_sender_trust": "signed"}}
    )
    assert s.min_sender_trust == "any"


def test_supports_sender_identity_is_feature_detection() -> None:
    modern = build_agent_info(_info({}, {"min_sender_trust": "any"}))
    legacy = build_agent_info(_info({}))
    assert modern is not None and modern.supports_sender_identity is True
    assert modern.prompt_endpoint.min_sender_trust == "any"
    assert legacy is not None and legacy.supports_sender_identity is False
    assert legacy.prompt_endpoint.min_sender_trust == "any"


async def test_registration_identity_and_id_sig(identity_keys: dict[str, NkeyUser]) -> None:
    alice = signer_from_seed(identity_keys["alice"].seed)
    id = AgentId.new("ACME", alice.public_key)
    id_sig = await sign_agent_id(
        signer=alice, id=id, agent="claude-code", owner="alice", prompt_subject=SUBJECT
    )
    ok = build_agent_info(
        _info({"user_nkey": alice.public_key, "account": "ACME", "id_sig": id_sig})
    )
    assert ok is not None and ok.identity == id and ok.id_sig_verified is True
    claim_only = build_agent_info(_info({"user_nkey": alice.public_key, "account": "ACME"}))
    assert (
        claim_only is not None and claim_only.identity == id and claim_only.id_sig_verified is False
    )
    tampered = build_agent_info(
        _info({"user_nkey": alice.public_key, "account": "ACME", "id_sig": id_sig[:-2] + "AA"})
    )
    assert tampered is not None and tampered.id_sig_verified is False
    wrong_owner = build_agent_info(
        _info(
            {"user_nkey": alice.public_key, "account": "ACME", "id_sig": id_sig, "owner": "mallory"}
        )
    )
    assert wrong_owner is not None and wrong_owner.id_sig_verified is False
    malformed = build_agent_info(_info({"user_nkey": "nope", "account": "ACME"}))
    assert malformed is not None and malformed.identity is None
    plain = build_agent_info(_info({}))
    assert plain is not None and plain.identity is None and plain.id_sig_verified is False


def test_max_payload_counts_the_framed_header() -> None:
    limit = 1024
    assert_within_max_payload(limit, limit)
    assert_within_max_payload(1000, limit, None, 24)
    with pytest.raises(PayloadTooLargeError) as exc_info:
        assert_within_max_payload(1000, limit, None, 25)
    err = exc_info.value
    assert err.header_bytes == 25 and err.actual == 1000 and err.limit == limit
    assert "Agent-Sender header 25 bytes" in str(err)
    assert isinstance(err, ValidationError)
    assert PayloadTooLargeError(limit=1, actual=2).header_bytes == 0
    assert "Agent-Sender" not in str(PayloadTooLargeError(limit=1, actual=2))
    # The connection cap binds when smaller.
    with pytest.raises(PayloadTooLargeError):
        assert_within_max_payload(500, limit, 520, 21)


def test_identity_errors_are_nats_agent_errors_not_validation_errors() -> None:
    assert issubclass(IdentityError, NatsAgentError)
    assert not issubclass(IdentityError, ValidationError)

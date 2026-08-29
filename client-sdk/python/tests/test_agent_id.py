"""``AgentId`` — the spec's parse fixtures plus the plan's extra rows (unit, no server).

The table lives in ``test-fixtures/identity/agent-id-fixtures.json`` and is
shared with the TypeScript suite: every row is exercised through
:meth:`AgentId.parse` (the ``parse`` list) and :meth:`AgentId.new` (the
``new`` list). Equality is string equality on the canonical form, so an
``AgentId`` works as a ``dict`` key and compares equal to its text.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from synadia_ai.agents import AgentId, InvalidAgentIdError
from synadia_ai.agents.identity.agent_id import (
    ACCOUNT_LENGTH_ALLOWANCE_BYTES,
    AGENT_ID_REGEX,
    assert_valid_account,
    assert_valid_user_key,
    is_account_key_shaped,
    is_user_key_shaped,
)
from tests.harness.nats_server import identity_fixture

FIXTURES: dict[str, Any] = json.loads(
    identity_fixture("agent-id-fixtures.json").read_text(encoding="utf-8")
)
OPERATOR_FORM_LENGTH = 113
A = "AABYLMBR6Q2CDXTLGRQCFA2GP76BGCDF7NZF2OVHH4RQ7L3Y3TZWJDRL"
U = "UAWW24XPLGOX3R3JF4OZEZZ6RUXMB55DSWJCEFFSUDFBCKJD4MSCMQYI"


def test_fixture_regex_is_the_sdk_regex() -> None:
    assert FIXTURES["regex"] == AGENT_ID_REGEX.pattern


@pytest.mark.parametrize("row", FIXTURES["parse"], ids=[r["note"] for r in FIXTURES["parse"]])
def test_parse_fixture_row(row: dict[str, Any]) -> None:
    if row["valid"]:
        parsed = AgentId.parse(row["input"])
        assert parsed == row["input"]
        assert str(parsed) == row["input"]
        assert parsed.account == row["account"]
        assert parsed.user == row["user"]
        if "length" in row:
            assert len(parsed) == row["length"]
        # Round trip through the two tokens.
        assert AgentId.new(parsed.account, parsed.user) == parsed
    else:
        with pytest.raises(InvalidAgentIdError):
            AgentId.parse(row["input"])
        with pytest.raises(InvalidAgentIdError):
            AgentId(row["input"])


@pytest.mark.parametrize("row", FIXTURES["new"], ids=[r["note"] for r in FIXTURES["new"]])
def test_new_fixture_row(row: dict[str, Any]) -> None:
    if row["valid"]:
        assert AgentId.new(row["account"], row["user"]) == row["string"]
    else:
        with pytest.raises(InvalidAgentIdError):
            AgentId.new(row["account"], row["user"])


def test_equality_hash_and_dict_keys() -> None:
    one = AgentId.parse(f"{A}.{U}")
    same = AgentId.new(A, U)
    other = AgentId.parse(FIXTURES["parse"][-1]["input"])  # same account, other user
    assert one == same
    assert hash(one) == hash(same)
    assert one != other
    assert {one: "x"}[same] == "x"
    assert one == f"{A}.{U}"  # a str subclass: equality with the text form
    assert isinstance(one, str)
    assert len(one) == OPERATOR_FORM_LENGTH
    assert repr(one).startswith("AgentId('")


def test_no_zero_agent_id() -> None:
    with pytest.raises(InvalidAgentIdError, match="empty"):
        AgentId.new("", U)
    with pytest.raises(InvalidAgentIdError, match="empty"):
        AgentId.new(A, "")
    with pytest.raises(InvalidAgentIdError, match="empty"):
        AgentId.parse("")


def test_shape_helpers_and_assertions() -> None:
    assert is_user_key_shaped(U)
    assert not is_user_key_shaped(U[:-1])
    assert not is_user_key_shaped(A)
    assert is_account_key_shaped(A)
    assert not is_account_key_shaped("ACME")
    assert_valid_user_key(U)
    assert_valid_account("ACME")
    assert_valid_account("$G")
    assert_valid_account(A)
    with pytest.raises(InvalidAgentIdError, match="nkeys check"):
        assert_valid_account(A[:-1] + "M")  # NKEY shape, bad CRC
    with pytest.raises(InvalidAgentIdError, match="subject-safe"):
        assert_valid_account("acme corp")
    with pytest.raises(InvalidAgentIdError, match="user public NKEY"):
        assert_valid_user_key(A)
    assert ACCOUNT_LENGTH_ALLOWANCE_BYTES == 64  # the size-bound allowance the TS SDK uses

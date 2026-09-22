"""The agent tools' definitions and argument parsing.

The package's embedded copy (``synadia_ai/agents/tools/definitions.json``)
must equal ``test-fixtures/agent-tools/``, the one place they are defined,
so the model reads the same words from the Python and the TypeScript SDK.
The argument parser turns every mistake a model makes into words. The
tools themselves run end to end against real agents in the host package's
suite (``agent-sdk/python/tests/test_agent_tools_e2e.py``), where
``AgentService`` is at hand.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from synadia_ai.agents import AgentTools, agent_tool_definitions
from synadia_ai.agents.tools._args import (
    AnswerArgs,
    ArgsError,
    DiscoverArgs,
    PromptArgs,
    WaitArgs,
    parse_answer_args,
    parse_cancel_args,
    parse_discover_args,
    parse_prompt_args,
    parse_wait_args,
)

FIXTURES_DIR = Path(__file__).resolve().parents[3] / "test-fixtures" / "agent-tools"
NAMES = [
    "discover_agents",
    "prompt_agent",
    "wait_agent",
    "answer_agent",
    "cancel_agent",
    "list_agent_calls",
]


def _fixture(name: str) -> Any:
    return json.loads((FIXTURES_DIR / f"{name}.json").read_text(encoding="utf-8"))


def test_the_definitions_equal_the_shared_fixtures_in_the_contracts_order() -> None:
    assert agent_tool_definitions() == [_fixture(name) for name in NAMES]


def test_the_definitions_are_a_fresh_copy_each_time() -> None:
    mine = agent_tool_definitions()
    mine[0]["description"] = "changed"
    assert agent_tool_definitions()[0]["description"] != "changed"


def test_the_call_result_schema_names_every_field_the_helper_produces() -> None:
    schema = _fixture("prompt_agent.result")
    assert sorted(schema["properties"]) == sorted(
        [
            "attachments",
            "call_id",
            "call_ids",
            "error",
            "label",
            "open_calls",
            "open_calls_note",
            "partial_reply",
            "question",
            "remaining",
            "reply",
            "state",
        ]
    )


def test_the_arguments_are_a_dict_or_its_json_text_and_an_empty_call_is_empty() -> None:
    assert parse_discover_args(None) == DiscoverArgs()
    assert parse_discover_args("") == DiscoverArgs()
    assert parse_discover_args('{"owner":"acme"}') == DiscoverArgs(owner="acme")
    assert parse_prompt_args({"address": "a", "prompt": "p"}) == PromptArgs(
        address="a", prompt="p", attachments=(), label=None, wait=True
    )


def test_properties_the_definitions_do_not_name_are_ignored() -> None:
    assert parse_answer_args({"call_id": "c", "answer": "yes", "request_id": "r"}) == AnswerArgs(
        call_id="c", answer="yes", wait=None
    )


def test_a_model_passing_an_error_field_is_not_mistaken_for_a_parse_error() -> None:
    assert parse_discover_args({"error": "x"}) == DiscoverArgs()


@pytest.mark.parametrize(
    ("result", "words"),
    [
        (parse_prompt_args("{nope"), "not valid JSON"),
        (parse_prompt_args([]), "must be a JSON object"),
        (parse_prompt_args({"prompt": "p"}), '"address" is required'),
        (parse_prompt_args({"address": "a", "prompt": ""}), '"prompt" is required'),
        (
            parse_prompt_args({"address": "a", "prompt": "p", "attachments": "f"}),
            "list of file paths",
        ),
        (
            parse_prompt_args({"address": "a", "prompt": "p", "wait": "no"}),
            '"wait" must be true or false',
        ),
        (parse_prompt_args({"address": "a", "prompt": "p", "label": ""}), '"label" must be'),
        (parse_wait_args({"call_ids": []}), "non-empty list"),
        (parse_wait_args({"call_ids": ["a"], "timeout_ms": -1}), '"timeout_ms"'),
        (parse_wait_args({"call_ids": ["a"], "timeout_ms": 1.5}), '"timeout_ms"'),
        (parse_wait_args({"call_ids": ["a"], "timeout_ms": True}), '"timeout_ms"'),
        (parse_answer_args({"call_id": "c"}), '"answer" is required'),
        (parse_cancel_args({"call_ids": [""]}), "non-empty list"),
        (parse_discover_args({"owner": 3}), '"owner" must be a non-empty string'),
    ],
)
def test_every_mistake_comes_back_in_words(result: object, words: str) -> None:
    assert isinstance(result, ArgsError)
    assert words in result.error


def test_repeated_call_ids_are_dropped_keeping_the_order() -> None:
    assert parse_wait_args({"call_ids": ["b", "a", "b"], "timeout_ms": 0}) == WaitArgs(
        call_ids=("b", "a"), timeout_ms=0
    )
    # JSON has one number type: 5.0 is five milliseconds.
    assert parse_wait_args({"call_ids": ["a"], "timeout_ms": 5.0}) == WaitArgs(
        call_ids=("a",), timeout_ms=5
    )


def test_misconfiguration_is_a_bug_and_raises() -> None:
    agents: Any = object()
    with pytest.raises(ValueError, match="max_calls"):
        AgentTools(agents, max_calls=0)
    with pytest.raises(ValueError, match="max_wait_s"):
        AgentTools(agents, max_wait_s=0)
    tools = AgentTools(agents)
    assert tools.definitions == agent_tool_definitions()

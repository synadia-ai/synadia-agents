"""The agent tools' definitions and argument parsing.

The package's embedded copy (``synadia_ai/agents/tools/definitions.json``
and ``blocking.json``) must equal ``test-fixtures/agent-tools/``, the one
place they are defined, so the model reads the same words from the Python
and the TypeScript SDK. A subset of the tools shows the same definitions,
less ``wait`` and with the blocking-only words when it has no
``wait_agent``. The argument parser turns every mistake a model makes into
words. The
tools themselves run end to end against real agents in the host package's
suite (``agent-sdk/python/tests/test_agent_tools_e2e.py``), where
``AgentService`` is at hand.
"""

from __future__ import annotations

import itertools
import json
from importlib import resources
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


DEFINITIONS = [_fixture(name) for name in NAMES]
BLOCKING: dict[str, str] = _fixture("blocking")
BLOCKING_THREE = ["discover_agents", "prompt_agent", "answer_agent"]
#: The helper touches its client only to discover and prompt.
AGENTS: Any = object()
#: Every subset of the six, the empty one too.
SUBSETS = [
    [name for name in NAMES if name in chosen]
    for size in range(len(NAMES) + 1)
    for chosen in itertools.combinations(NAMES, size)
]


def _derived(offered: list[str]) -> list[dict[str, Any]]:
    """What a subset shows, by the contract's rule.

    The fixtures of the tools offered and, without ``wait_agent``, each
    without ``wait`` and with its blocking-only description where it has one.
    """
    out: list[dict[str, Any]] = []
    for definition in DEFINITIONS:
        if definition["name"] not in offered:
            continue
        if "wait_agent" in offered:
            out.append(definition)
            continue
        properties = {
            k: v for k, v in definition["parameters"]["properties"].items() if k != "wait"
        }
        out.append(
            {
                **definition,
                "description": BLOCKING.get(definition["name"], definition["description"]),
                "parameters": {**definition["parameters"], "properties": properties},
            }
        )
    return out


def _sensible(tools: list[str]) -> bool:
    """A subset makes sense when it has a tool, and prompt_agent for any that works on calls."""
    return bool(tools) and (
        "prompt_agent" in tools or all(name == "discover_agents" for name in tools)
    )


def test_the_definitions_equal_the_shared_fixtures_in_the_contracts_order() -> None:
    assert agent_tool_definitions() == DEFINITIONS


def test_the_blocking_only_descriptions_equal_the_shared_fixture() -> None:
    embedded = resources.files("synadia_ai.agents.tools").joinpath("blocking.json")
    assert json.loads(embedded.read_text("utf-8")) == BLOCKING


def test_a_blocking_only_description_exists_exactly_where_one_mentions_wait_agent() -> None:
    mentioning = [
        d["name"]
        for d in DEFINITIONS
        if d["name"] != "wait_agent" and "wait_agent" in d["description"]
    ]
    assert sorted(BLOCKING) == sorted(mentioning)
    for words in BLOCKING.values():
        assert "wait_agent" not in words
        assert "wait set to" not in words


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


def test_the_tools_offered_are_all_six_by_default() -> None:
    assert AgentTools(AGENTS).definitions == DEFINITIONS


def test_a_subset_shows_the_fixtures_without_wait_agent_nothing_waits_later() -> None:
    for tools in filter(_sensible, SUBSETS):
        assert AgentTools(AGENTS, tools=tools).definitions == _derived(tools), tools
    blocking = AgentTools(AGENTS, tools=BLOCKING_THREE).definitions
    assert [d["name"] for d in blocking] == BLOCKING_THREE
    for definition in blocking:
        assert "wait" not in definition["parameters"]["properties"]
        assert "wait_agent" not in definition["description"]


def test_the_tools_keep_the_contracts_order_and_drop_repeats() -> None:
    tools = AgentTools(
        AGENTS,
        tools=["answer_agent", "prompt_agent", "answer_agent", "discover_agents"],
    )
    assert [d["name"] for d in tools.definitions] == BLOCKING_THREE


def test_a_subset_that_makes_no_sense_is_refused_at_construction() -> None:
    for tools in SUBSETS:
        if _sensible(tools):
            continue
        words = "names no tool" if not tools else "without prompt_agent"
        with pytest.raises(ValueError, match=words):
            AgentTools(AGENTS, tools=tools)
    with pytest.raises(ValueError, match="'ask_agent', which is not one of"):
        AgentTools(AGENTS, tools=["prompt_agent", "ask_agent"])
    with pytest.raises(ValueError, match="a list of tool names"):
        AgentTools(AGENTS, tools="prompt_agent")


async def test_a_tool_not_offered_and_wait_false_without_wait_agent_are_refused_in_words() -> None:
    tools = AgentTools(AGENTS, tools=BLOCKING_THREE)
    for name in ["wait_agent", "cancel_agent", "list_agent_calls"]:
        assert await tools.execute(name, {"call_ids": ["c"]}) == {
            "error": f'the tool "{name}" is not offered; '
            "your tools are discover_agents, prompt_agent, answer_agent"
        }
    assert await tools.execute("ask_agent") == {"error": 'unknown tool "ask_agent"'}
    assert await tools.execute("prompt_agent", {"address": "a", "prompt": "p", "wait": False}) == {
        "error": 'prompt_agent: "wait" cannot be false here; '
        "the call waits for the reply or a question"
    }
    assert await tools.execute("answer_agent", {"call_id": "c", "answer": "a", "wait": False}) == {
        "error": 'answer_agent: "wait" cannot be false here; '
        "the call waits for the reply or the next question"
    }
    # A result points the model only to tools offered.
    assert await tools.execute("answer_agent", {"call_id": "c", "answer": "a"}) == {
        "error": '"c": no such call in your calls'
    }
    everything = AgentTools(AGENTS)
    assert await everything.execute("answer_agent", {"call_id": "c", "answer": "a"}) == {
        "error": '"c": no such call in your calls; list_agent_calls shows them'
    }


def test_misconfiguration_is_a_bug_and_raises() -> None:
    agents: Any = object()
    with pytest.raises(ValueError, match="max_calls"):
        AgentTools(agents, max_calls=0)
    with pytest.raises(ValueError, match="max_wait_s"):
        AgentTools(agents, max_wait_s=0)
    tools = AgentTools(agents)
    assert tools.definitions == agent_tool_definitions()

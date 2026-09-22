"""The agent tools' definitions and argument parsing.

The package's embedded copy (``synadia_ai/agents/tools/definitions.json``
and ``blocking.json``) must equal ``test-fixtures/agent-tools/``, the one
place they are defined, so the model reads the same words from the Python
and the TypeScript SDK. A subset of the tools shows the same definitions,
less ``wait`` and with the blocking-only words when it has no
``wait_agent``. The argument parser turns every mistake a model makes into
words, and each subset's results say what to do about open calls in words
it can act on, shown against a stand-in agent that keeps every call open.
The tools themselves run end to end against real agents in the host
package's suite (``agent-sdk/python/tests/test_agent_tools_e2e.py``), where
``AgentService`` is at hand.
"""

from __future__ import annotations

import asyncio
import itertools
import json
from collections.abc import AsyncIterator
from importlib import resources
from pathlib import Path
from typing import Any

import pytest

from synadia_ai.agents import (
    AGENT_TOOL_NAMES,
    BLOCKING_AGENT_TOOLS,
    AgentTools,
    agent_tool_definitions,
)
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

ASKER = "agents.prompt.fake.o.asker"


class _Question:
    prompt = "may I?"
    attachments = None

    async def reply(self, _answer: str) -> None:
        return None


class _Asker:
    """An agent at ``ASKER`` that asks a question on every prompt, then waits until dropped."""

    prompt_subject = ASKER
    id_sig_verified = False
    identity = None

    def prompt(self, _text: str, **_options: Any) -> AsyncIterator[Any]:
        return self._ask()

    async def _ask(self) -> AsyncIterator[Any]:
        yield _Question()
        await asyncio.Event().wait()


class _AskingAgents:
    """A client that finds one agent, the asker: every call stays open."""

    async def discover(self, **_options: Any) -> list[Any]:
        return [_Asker()]


#: The words about open calls, with one call open and room for one, by what
#: collects a call (``wait_agent``, or else answering its questions) and
#: whether ``cancel_agent`` stops one. No other tool changes them.
OPEN_CALL_WORDS: dict[str, dict[str, str]] = {
    "answer only": {
        "note": "1 call you started is still open: answer its questions with answer_agent.",
        "served": "1 call you started is still open. Calls end with the prompt you are "
        "answering: answer its questions with answer_agent before you answer.",
        "refusal": "all 1 tracked calls are still open; "
        "answer their questions with answer_agent before you start another",
    },
    "answer or cancel": {
        "note": "1 call you started is still open: "
        "answer its questions with answer_agent, or stop it with cancel_agent.",
        "served": "1 call you started is still open. Calls end with the prompt you are "
        "answering: answer its questions with answer_agent before you answer.",
        "refusal": "all 1 tracked calls are still open; answer their questions with "
        "answer_agent or stop some with cancel_agent before you start another",
    },
    "wait only": {
        "note": "1 call you started is still open: collect it with wait_agent.",
        "served": "1 call you started is still open. Calls end with the prompt you are "
        "answering: collect it with wait_agent before you answer.",
        "refusal": "all 1 tracked calls are still open; "
        "collect some with wait_agent before you start another",
    },
    "wait or cancel": {
        "note": "1 call you started is still open: "
        "collect it with wait_agent, or stop it with cancel_agent.",
        "served": "1 call you started is still open. Calls end with the prompt you are "
        "answering: collect it with wait_agent before you answer.",
        "refusal": "all 1 tracked calls are still open; collect some with wait_agent "
        "or stop some with cancel_agent before you start another",
    },
}


def _open_call_words(tools: list[str]) -> dict[str, str]:
    collect = "wait" if "wait_agent" in tools else "answer"
    return OPEN_CALL_WORDS[f"{collect} {'or cancel' if 'cancel_agent' in tools else 'only'}"]


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
    """Whether a subset makes sense.

    It has a tool, prompt_agent for any that works on calls, and answer_agent
    with prompt_agent.
    """
    if not tools:
        return False
    if "prompt_agent" in tools:
        return "answer_agent" in tools
    return all(name == "discover_agents" for name in tools)


def _refusal(tools: list[str]) -> str:
    """Why a subset that makes no sense is refused."""
    if not tools:
        return "names no tool"
    if "prompt_agent" in tools:
        return "prompt_agent without answer_agent, so a question .* would wait out its timeout"
    return "without prompt_agent"


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


def test_the_blocking_three_name_no_tool_outside_the_three() -> None:
    # A model shown a tool's name it does not have would try to call it.
    shown = json.dumps(AgentTools(AGENTS, tools=BLOCKING_THREE).definitions)
    for name in NAMES:
        if name not in BLOCKING_THREE:
            assert name not in shown, name


def test_constants_name_the_six_and_the_blocking_three_construction_accepts() -> None:
    assert isinstance(AGENT_TOOL_NAMES, tuple)
    assert isinstance(BLOCKING_AGENT_TOOLS, tuple)
    assert list(AGENT_TOOL_NAMES) == NAMES
    # The three section 5 names for an agent that runs no calls at once: the
    # smallest subset that makes sense and can discover and prompt.
    assert list(BLOCKING_AGENT_TOOLS) == BLOCKING_THREE
    smallest = min(
        (t for t in SUBSETS if _sensible(t) and {"discover_agents", "prompt_agent"} <= set(t)),
        key=len,
    )
    assert list(BLOCKING_AGENT_TOOLS) == smallest
    in_order = [name for name in AGENT_TOOL_NAMES if name in BLOCKING_AGENT_TOOLS]
    assert in_order == list(BLOCKING_AGENT_TOOLS)
    tools = AgentTools(AGENTS, tools=BLOCKING_AGENT_TOOLS)
    assert tools.definitions == _derived(BLOCKING_THREE)


def test_the_tools_keep_the_contracts_order_and_drop_repeats() -> None:
    tools = AgentTools(
        AGENTS,
        tools=["answer_agent", "prompt_agent", "answer_agent", "discover_agents"],
    )
    assert [d["name"] for d in tools.definitions] == BLOCKING_THREE


def test_a_subset_that_makes_no_sense_is_refused_at_construction() -> None:
    refused = [tools for tools in SUBSETS if not _sensible(tools)]
    for tools in refused:
        with pytest.raises(ValueError, match=_refusal(tools)):
            AgentTools(AGENTS, tools=tools)
    assert len([tools for tools in refused if "prompt_agent" in tools]) == 16
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


async def test_every_subset_that_starts_calls_is_told_about_them_in_words_it_can_act_on() -> None:
    # prompt_agent always comes with answer_agent, so every subset that starts
    # a call can collect it: there are no words for having no way.
    starting = [tools for tools in SUBSETS if _sensible(tools) and "prompt_agent" in tools]
    assert len(starting) == 16
    for tools in starting:
        words = _open_call_words(tools)
        asking: Any = _AskingAgents()
        async with AgentTools(asking, tools=tools, max_calls=1) as helper:
            asked = await helper.execute("prompt_agent", {"address": ASKER, "prompt": "go"})
            assert (asked["state"], asked["open_calls"]) == ("input_required", 1), tools
            assert asked["open_calls_note"] == words["note"], tools
            assert await helper.execute("prompt_agent", {"address": ASKER, "prompt": "go"}) == {
                "error": words["refusal"],
                "open_calls": 1,
                "open_calls_note": words["note"],
            }, tools
            async with helper.prompt_scope():
                served = await helper.execute("prompt_agent", {"address": ASKER, "prompt": "go"})
                assert served["open_calls_note"] == words["served"], tools


def test_misconfiguration_is_a_bug_and_raises() -> None:
    agents: Any = object()
    with pytest.raises(ValueError, match="max_calls"):
        AgentTools(agents, max_calls=0)
    with pytest.raises(ValueError, match="max_wait_s"):
        AgentTools(agents, max_wait_s=0)
    tools = AgentTools(agents)
    assert tools.definitions == agent_tool_definitions()

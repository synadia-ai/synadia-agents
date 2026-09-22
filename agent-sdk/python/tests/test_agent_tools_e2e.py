"""The agent tools (``docs/agent-tools.md``), end to end against real agents.

``AgentTools`` lives in the caller package (``synadia_ai.agents``); it runs
here because this suite has ``AgentService`` at hand, for the agents the
tools prompt and for the served-prompt scope its request interceptor opens.
Blocking and detached calls, questions, waiting, cancelling, limits, the
scope, files, the loop guards, errors as results, the tool-call ID and the
extension hooks. The TypeScript suite's ``agent-tools.test.ts`` proves the
same on its side.

One worker agent does what its prompt says (``echo:``, ``sleep:<ms>:``,
``ask:``, ``gate:<key>``, ``files:``, ...), so each test drives it through
the tools alone. Every result is checked against the shape the fixtures in
``test-fixtures/agent-tools/`` define.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from synadia_ai.agents import (
    AGENT_TOOLS_QUESTION_REFUSAL,
    Agent,
    Agents,
    AgentTools,
    AgentToolsExtension,
    AgentToolsPromptContext,
    AgentToolsPromptRewrite,
    AgentToolsReplyContext,
    Attachment,
    DiscoverFilter,
    Envelope,
    Identity,
    PromptExtras,
    PromptInterceptorContext,
    ResponseChunk,
    SettledInfo,
    signer_from_seed,
)

from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from tests.harness.wait import wait_for

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser, NkeyUser
    from tests.harness.nats_server import RunningServer

FIXTURES_DIR = Path(__file__).resolve().parents[3] / "test-fixtures" / "agent-tools"
CALL_FIELDS = set(
    json.loads((FIXTURES_DIR / "prompt_agent.result.json").read_text(encoding="utf-8"))[
        "properties"
    ]
)
STATES = {"running", "input_required", "completed", "failed", "cancelled", "expired"}
#: The helper's logger in the tests that read what it logs.
TOOLS_LOG = logging.getLogger("tests.agent_tools")


def conforms(result: Mapping[str, Any], extension_fields: frozenset[str] = frozenset()) -> None:
    """``result`` conforms to ``prompt_agent.result.json``: a call, a refusal, or a timeout."""
    unexpected = set(result) - CALL_FIELDS - extension_fields
    assert not unexpected, f"unexpected fields {unexpected}"
    assert ("open_calls" in result) == ("open_calls_note" in result)
    if "call_id" not in result:
        if "call_ids" in result:
            assert result["state"] == "running"
        else:
            # A refusal: the error alone.
            assert isinstance(result["error"], str)
            assert "state" not in result
        return
    state = result["state"]
    assert state in STATES
    has = result.__contains__
    if state == "completed":
        assert isinstance(result["reply"], str)
        assert not (has("question") or has("error") or has("partial_reply"))
    elif state == "input_required":
        assert isinstance(result["question"], str)
        assert not (has("reply") or has("error") or has("partial_reply"))
    elif state in ("failed", "expired"):
        assert isinstance(result["error"], str)
        assert not (has("reply") or has("question"))
    else:
        assert not (has("reply") or has("question") or has("error"))


def call(result: Mapping[str, Any]) -> dict[str, Any]:
    conforms(result)
    return dict(result)


def errors_logged(caplog: pytest.LogCaptureFixture) -> list[str]:
    """The error lines the helper logged through ``TOOLS_LOG``."""
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == TOOLS_LOG.name and r.levelno == logging.ERROR
    ]


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


@dataclass
class Gate:
    event: asyncio.Event = field(default_factory=asyncio.Event)
    reached: bool = False


@dataclass
class World:
    nc: NATSClient
    alice: NkeyUser
    worker_address: str = ""
    #: A second worker: a Python host serves one prompt at a time per instance.
    other_address: str = ""
    gates: dict[str, Gate] = field(default_factory=dict)
    #: What the worker's questions were answered with, in order.
    answers: list[str] = field(default_factory=list)
    #: What the worker received, per prompt.
    received: list[Envelope] = field(default_factory=list)
    services: list[AgentService] = field(default_factory=list)
    closers: list[Callable[[], Awaitable[None]]] = field(default_factory=list)

    def gate(self, key: str) -> Gate:
        return self.gates.setdefault(key, Gate())

    async def work(self, envelope: Envelope, stream: PromptStream) -> None:
        self.received.append(envelope)
        command, _, arg = envelope.prompt.partition(":")
        if command == "echo":
            await stream.send(f"echo:{arg}")
        elif command == "sleep":
            ms, _, text = arg.partition(":")
            await asyncio.sleep(int(ms) / 1000)
            await stream.send(text)
        elif command == "ask":
            answer = await stream.ask(arg, timeout=10)
            self.answers.append(answer.prompt)
            await stream.send(f"answered:{answer.prompt}")
        elif command == "ask-twice":
            first = await stream.ask("first?", timeout=10)
            second = await stream.ask("second?", timeout=10)
            await stream.send(f"{first.prompt}+{second.prompt}")
        elif command == "ask-file":
            answer = await stream.ask(
                "look at this",
                timeout=10,
                attachments=[Attachment.from_bytes("q.txt", b"question file")],
            )
            await stream.send(f"answered:{answer.prompt}")
        elif command == "gate":
            await stream.send("partial ")
            g = self.gate(arg)
            g.reached = True
            await g.event.wait()
            await stream.send("rest")
        elif command == "files":
            await stream.send(
                ResponseChunk(
                    text="here",
                    attachments=[
                        Attachment(filename="report.txt", content=b64("hello")),
                        Attachment(filename="../escape.txt", content=b64("x")),
                        Attachment(filename="bad.bin", content="!!not base64"),
                    ],
                )
            )
        elif command == "big":
            await stream.send(
                ResponseChunk(
                    text="big",
                    attachments=[
                        Attachment(filename="a.txt", content=b64("hello")),
                        Attachment(filename="b.txt", content=b64("world!")),
                    ],
                )
            )
        elif command == "attach":
            got = ",".join(
                f"{a.filename}={a.to_bytes().decode()}" for a in envelope.attachments or []
            )
            await stream.send(f"got:{got}")
        else:
            await stream.send(f"unknown:{envelope.prompt}")

    async def service(
        self,
        name: str,
        handler: Callable[[Envelope, PromptStream], Awaitable[None]],
        **options: Any,
    ) -> AgentService:
        svc = AgentService(
            nc=self.nc,
            agent="tools-test",
            owner="o",
            session_name=name,
            heartbeat_interval_s=3600,
            **options,
        )
        svc.on_prompt(handler)
        await svc.start()
        self.services.append(svc)
        return svc

    def client(self, *, signed: bool = True, **options: Any) -> Agents:
        agents = Agents(
            nc=self.nc,
            identity=Identity(signer=signer_from_seed(self.alice.seed)) if signed else None,
            **options,
        )
        self.closers.append(agents.close)
        return agents

    def tools(self, agents: Agents | None = None, **options: Any) -> AgentTools:
        tools = AgentTools(
            agents if agents is not None else self.client(), discover_timeout=0.25, **options
        )
        self.closers.append(tools.aclose)
        return tools

    async def asker(self, name: str, **options: Any) -> tuple[str, list[str]]:
        """An agent that asks one question with a file and records the answer.

        It waits up to 10 seconds: a refusal shows up at once, a dropped
        question only after the test's own wait has given up. Returns its
        address and what it got.
        """
        got: list[str] = []

        async def ask(_envelope: Envelope, stream: PromptStream) -> None:
            answer = await stream.ask(
                "may I?",
                timeout=10,
                attachments=[Attachment.from_bytes("q.txt", b"question file")],
            )
            got.append(answer.prompt)

        return (await self.service(name, ask, **options)).subject.prompt, got


@pytest.fixture
async def world(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> AsyncIterator[World]:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    w = World(nc=nc, alice=identity_keys["alice"])
    worker = await w.service(
        "worker",
        w.work,
        identity=ServiceIdentity(signer=signer_from_seed(w.alice.seed)),
    )
    w.worker_address = worker.subject.prompt
    w.other_address = (await w.service("other", w.work)).subject.prompt
    try:
        yield w
    finally:
        for g in w.gates.values():
            g.event.set()
        for close in reversed(w.closers):
            await close()
        for svc in w.services:
            await svc.stop()


async def serve(agents: Agents, name: str, text: str = "go") -> str:
    """Prompt the served agent ``name`` and return its reply."""
    found = await agents.discover(timeout=0.25, filter=DiscoverFilter(session_name=name))
    reply = ""
    async for msg in found[0].prompt(text):
        if isinstance(msg, ResponseChunk):
            reply += msg.text
    return reply


class HeldLook(AgentToolsExtension):
    """A reply look that holds each question until the test lets it go.

    A cancel lands while the question is taken in.
    """

    def __init__(self) -> None:
        self.held = False
        self.released = asyncio.Event()

    async def after_reply(self, ctx: AgentToolsReplyContext) -> Mapping[str, Any] | None:
        if ctx.kind == "question":
            self.held = True
            await self.released.wait()
        return None


@contextlib.asynccontextmanager
async def refusals_sent(nc: NATSClient) -> AsyncIterator[list[str]]:
    """The refusals that go out on the wire, by the subject each went to.

    The asking agent hears only the first, so a second shows up only here.
    """
    subjects: list[str] = []

    async def seen(msg: Msg) -> None:
        if msg.data == AGENT_TOOLS_QUESTION_REFUSAL.encode():
            subjects.append(msg.subject)

    sub = await nc.subscribe("_INBOX.>", cb=seen)
    await nc.flush()
    try:
        yield subjects
    finally:
        await sub.unsubscribe()


# --- blocking ----------------------------------------------------------------


async def test_discovery_gives_one_entry_per_address_showing_an_instance_that_verifies(
    world: World,
) -> None:
    await world.service("worker", world.work)
    result = await world.tools().execute("discover_agents", {"name": "worker"})
    assert result == {
        "agents": [
            {
                "address": world.worker_address,
                "agent": "tools-test",
                "owner": "o",
                "name": "worker",
                "description": result["agents"][0]["description"],
                "identity": result["agents"][0]["identity"],
                "identity_verified": True,
                "requires_signed_prompts": False,
                "accepts_attachments": True,
                "instances": 2,
            }
        ]
    }
    assert result["agents"][0]["identity"].startswith("$G.U")


async def test_prompt_agent_waits_for_the_reply_by_default(world: World) -> None:
    result = call(
        await world.tools().execute(
            "prompt_agent", {"address": world.worker_address, "prompt": "echo:hi"}
        )
    )
    assert result == {"call_id": result["call_id"], "state": "completed", "reply": "echo:hi"}
    assert result["call_id"].startswith("call_")
    assert len(result["call_id"]) == len("call_") + 12


async def test_a_blocking_question_goes_to_the_model_and_answer_agent_waits(
    world: World,
) -> None:
    tools = world.tools()
    asked = call(
        await tools.execute("prompt_agent", {"address": world.worker_address, "prompt": "ask:ok?"})
    )
    assert asked["state"] == "input_required"
    assert asked["question"] == "ok?"
    # The question keeps the call open, and every result says so.
    assert asked["open_calls"] == 1
    done = call(await tools.execute("answer_agent", {"call_id": asked["call_id"], "answer": "yes"}))
    assert done == {"call_id": asked["call_id"], "state": "completed", "reply": "answered:yes"}
    assert world.answers[-1] == "yes"


async def test_several_questions_in_one_stream_come_one_after_another(world: World) -> None:
    tools = world.tools()
    first = call(
        await tools.execute(
            "prompt_agent", {"address": world.worker_address, "prompt": "ask-twice"}
        )
    )
    assert first["question"] == "first?"
    second = call(await tools.execute("answer_agent", {"call_id": first["call_id"], "answer": "a"}))
    assert (second["state"], second["question"]) == ("input_required", "second?")
    done = call(await tools.execute("answer_agent", {"call_id": first["call_id"], "answer": "b"}))
    assert done["reply"] == "a+b"


async def test_answer_agent_refuses_a_call_with_no_open_question(world: World) -> None:
    tools = world.tools()
    done = call(
        await tools.execute("prompt_agent", {"address": world.worker_address, "prompt": "echo:x"})
    )
    result = await tools.execute("answer_agent", {"call_id": done["call_id"], "answer": "yes"})
    conforms(result)
    assert "has no open question: it is completed" in result["error"]


# --- detached calls and wait_agent ---------------------------------------------


async def test_wait_false_returns_at_once_and_wait_agent_picks_polls_and_times_out(
    world: World,
) -> None:
    tools = world.tools()
    address = world.worker_address
    slow = call(
        await tools.execute(
            "prompt_agent",
            {"address": address, "prompt": "sleep:600:slow", "wait": False, "label": "slow one"},
        )
    )
    assert (slow["state"], slow["label"], slow["open_calls"]) == ("running", "slow one", 1)
    fast = call(
        await tools.execute(
            "prompt_agent",
            {"address": world.other_address, "prompt": "sleep:150:fast", "wait": False},
        )
    )
    assert fast["open_calls"] == 2
    ids = [slow["call_id"], fast["call_id"]]

    poll = await tools.execute("wait_agent", {"call_ids": ids, "timeout_ms": 0})
    conforms(poll)
    assert (poll["state"], poll["call_ids"], poll["open_calls"]) == ("running", ids, 2)
    timed_out = await tools.execute("wait_agent", {"call_ids": ids, "timeout_ms": 20})
    assert (timed_out["state"], timed_out["call_ids"]) == ("running", ids)

    first = call(await tools.execute("wait_agent", {"call_ids": ids}))
    assert first["call_id"] == fast["call_id"]
    assert (first["reply"], first["remaining"], first["open_calls"]) == (
        "fast",
        [slow["call_id"]],
        1,
    )
    second = call(await tools.execute("wait_agent", {"call_ids": [slow["call_id"]]}))
    assert second == {
        "call_id": slow["call_id"],
        "state": "completed",
        "label": "slow one",
        "reply": "slow",
        "remaining": [],
    }


async def test_wait_agent_returns_the_call_that_finished_first_whatever_the_order_given(
    world: World,
) -> None:
    tools = world.tools()
    address = world.worker_address
    a = call(
        await tools.execute(
            "prompt_agent", {"address": address, "prompt": "sleep:50:a", "wait": False}
        )
    )
    b = call(
        await tools.execute(
            "prompt_agent", {"address": address, "prompt": "sleep:250:b", "wait": False}
        )
    )
    # Both finish before anyone asks.
    await tools.execute("wait_agent", {"call_ids": [b["call_id"]]})
    first = call(await tools.execute("wait_agent", {"call_ids": [b["call_id"], a["call_id"]]}))
    assert (first["call_id"], first["reply"], first["remaining"]) == (a["call_id"], "a", [])


async def test_fetching_a_finished_call_is_idempotent(world: World) -> None:
    tools = world.tools()
    c = call(
        await tools.execute(
            "prompt_agent", {"address": world.worker_address, "prompt": "echo:same", "wait": False}
        )
    )
    once = await tools.execute("wait_agent", {"call_ids": [c["call_id"]]})
    twice = await tools.execute("wait_agent", {"call_ids": [c["call_id"]]})
    assert twice == once
    cancelled = await tools.execute("cancel_agent", {"call_ids": [c["call_id"]]})
    assert cancelled == {
        "calls": [{"call_id": c["call_id"], "state": "completed", "reply": "echo:same"}]
    }


async def test_an_answer_to_a_detached_call_returns_running(world: World) -> None:
    tools = world.tools()
    c = call(
        await tools.execute(
            "prompt_agent", {"address": world.worker_address, "prompt": "ask:go?", "wait": False}
        )
    )
    asked = call(await tools.execute("wait_agent", {"call_ids": [c["call_id"]]}))
    assert (asked["state"], asked["question"], asked["remaining"]) == ("input_required", "go?", [])
    # Asked again, the same open question.
    again = await tools.execute("wait_agent", {"call_ids": [c["call_id"]], "timeout_ms": 0})
    assert again == asked
    answered = call(await tools.execute("answer_agent", {"call_id": c["call_id"], "answer": "go"}))
    assert (answered["state"], answered["open_calls"]) == ("running", 1)
    done = call(await tools.execute("wait_agent", {"call_ids": [c["call_id"]]}))
    assert (done["state"], done["reply"]) == ("completed", "answered:go")


async def test_answer_agents_wait_overrides_the_mode_the_call_was_started_in(
    world: World,
) -> None:
    tools = world.tools()
    c = call(
        await tools.execute(
            "prompt_agent", {"address": world.worker_address, "prompt": "ask:now?", "wait": False}
        )
    )
    await tools.execute("wait_agent", {"call_ids": [c["call_id"]]})
    done = call(
        await tools.execute("answer_agent", {"call_id": c["call_id"], "answer": "ok", "wait": True})
    )
    assert (done["state"], done["reply"]) == ("completed", "answered:ok")


# --- cancel, expired, list -----------------------------------------------------------


async def test_cancel_agent_returns_the_text_so_far_and_refuses_an_open_question(
    world: World,
) -> None:
    tools = world.tools()
    address = world.worker_address
    running = call(
        await tools.execute(
            "prompt_agent", {"address": address, "prompt": "gate:cancel", "wait": False}
        )
    )
    await wait_for(lambda: world.gate("cancel").reached, what="the first chunk")
    await asyncio.sleep(0.05)
    asking = call(
        await tools.execute(
            "prompt_agent", {"address": world.other_address, "prompt": "ask:cancel me?"}
        )
    )
    assert asking["state"] == "input_required"

    result = await tools.execute(
        "cancel_agent", {"call_ids": [running["call_id"], asking["call_id"], "call_nope"]}
    )
    assert result["calls"][:2] == [
        {"call_id": running["call_id"], "state": "cancelled", "partial_reply": "partial "},
        {"call_id": asking["call_id"], "state": "cancelled"},
    ]
    assert result["calls"][2]["call_id"] == "call_nope"
    assert "no such call" in result["calls"][2]["error"]
    await wait_for(lambda: AGENT_TOOLS_QUESTION_REFUSAL in world.answers, what="the refusal")
    # Cancelled is final: what the worker sends later is discarded.
    world.gate("cancel").event.set()
    await asyncio.sleep(0.1)
    after = await tools.execute("wait_agent", {"call_ids": [running["call_id"]]})
    assert (after["state"], after["partial_reply"]) == ("cancelled", "partial ")


async def test_cancelling_the_task_cancels_a_blocking_call_and_only_stops_a_wait(
    world: World,
) -> None:
    tools = world.tools()
    address = world.worker_address
    pending = asyncio.create_task(
        tools.execute("prompt_agent", {"address": address, "prompt": "gate:abort"})
    )
    await wait_for(lambda: world.gate("abort").reached, what="the worker to start")
    await asyncio.sleep(0.05)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending

    async def cancelled() -> bool:
        listed = await tools.execute("list_agent_calls")
        return bool(listed["calls"]) and listed["calls"][0]["state"] == "cancelled"

    for _ in range(100):
        if await cancelled():
            break
        await asyncio.sleep(0.02)
    listed = await tools.execute("list_agent_calls")
    result = await tools.execute("wait_agent", {"call_ids": [listed["calls"][0]["call_id"]]})
    assert (result["state"], result["partial_reply"]) == ("cancelled", "partial ")

    c = call(
        await tools.execute(
            "prompt_agent",
            {"address": world.other_address, "prompt": "sleep:200:later", "wait": False},
        )
    )
    waiting = asyncio.create_task(tools.execute("wait_agent", {"call_ids": [c["call_id"]]}))
    await asyncio.sleep(0.02)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    later = call(await tools.execute("wait_agent", {"call_ids": [c["call_id"]]}))
    assert later["reply"] == "later"


async def test_a_call_past_its_runtime_limit_is_expired(world: World) -> None:
    tools = world.tools(max_wait_s=0.3)
    result = call(
        await tools.execute(
            "prompt_agent", {"address": world.worker_address, "prompt": "gate:expire"}
        )
    )
    assert (result["state"], result["partial_reply"]) == ("expired", "partial ")
    assert "runtime limit of 300 ms" in result["error"]


async def test_wait_agents_timeout_is_capped_by_configuration(world: World) -> None:
    tools = world.tools(max_wait_agent_s=0.1)
    c = call(
        await tools.execute(
            "prompt_agent", {"address": world.worker_address, "prompt": "gate:cap", "wait": False}
        )
    )
    loop = asyncio.get_running_loop()
    started = loop.time()
    result = await tools.execute("wait_agent", {"call_ids": [c["call_id"]], "timeout_ms": 60_000})
    assert (result["state"], result["call_ids"]) == ("running", [c["call_id"]])
    assert loop.time() - started < 2


async def test_list_agent_calls_gives_label_address_state_and_times(world: World) -> None:
    tools = world.tools()
    address = world.worker_address
    done = call(
        await tools.execute(
            "prompt_agent", {"address": address, "prompt": "echo:l", "label": "first"}
        )
    )
    running = call(
        await tools.execute(
            "prompt_agent", {"address": address, "prompt": "gate:list", "wait": False}
        )
    )
    result = await tools.execute("list_agent_calls")
    first, second = result["calls"]
    assert first == {
        "call_id": done["call_id"],
        "label": "first",
        "address": address,
        "state": "completed",
        "started_at": first["started_at"],
        "ended_at": first["ended_at"],
    }
    assert second == {
        "call_id": running["call_id"],
        "address": address,
        "state": "running",
        "started_at": second["started_at"],
    }
    for stamp in (first["started_at"], first["ended_at"], second["started_at"]):
        # The form JavaScript's toISOString writes, as the TypeScript SDK does.
        assert len(stamp) == len("2026-09-22T00:00:00.000Z")
        assert stamp.endswith("Z")
    assert result["open_calls"] == 1
    assert "1 call you started is still open" in result["open_calls_note"]


async def test_the_longest_finished_call_is_dropped_and_all_open_is_refused(
    world: World,
) -> None:
    tools = world.tools(max_calls=2)
    address = world.worker_address
    a = call(
        await tools.execute(
            "prompt_agent", {"address": address, "prompt": "gate:ev-a", "wait": False}
        )
    )
    b = call(
        await tools.execute(
            "prompt_agent", {"address": world.other_address, "prompt": "gate:ev-b", "wait": False}
        )
    )
    refused = await tools.execute("prompt_agent", {"address": address, "prompt": "echo:c"})
    conforms(refused)
    assert "all 2 tracked calls are still open" in refused["error"]

    world.gate("ev-a").event.set()
    assert call(await tools.execute("wait_agent", {"call_ids": [a["call_id"]]}))["state"] == (
        "completed"
    )
    c = call(await tools.execute("prompt_agent", {"address": address, "prompt": "echo:c"}))
    assert c["reply"] == "echo:c"
    gone = await tools.execute("wait_agent", {"call_ids": [a["call_id"]]})
    assert "no such call" in gone["error"]
    listed = await tools.execute("list_agent_calls")
    assert [x["call_id"] for x in listed["calls"]] == [b["call_id"], c["call_id"]]


# --- failing and expiring with a question open -----------------------------------------


async def test_a_call_that_expires_refuses_its_open_question(world: World) -> None:
    address, got = await world.asker("asker-expire")
    tools = world.tools(max_wait_s=0.3)
    asked = call(await tools.execute("prompt_agent", {"address": address, "prompt": "go"}))
    assert (asked["state"], asked["question"]) == ("input_required", "may I?")
    await wait_for(lambda: bool(got), timeout_s=5, what="the refusal")
    assert got == [AGENT_TOOLS_QUESTION_REFUSAL]
    expired = call(await tools.execute("wait_agent", {"call_ids": [asked["call_id"]]}))
    assert expired["state"] == "expired"
    assert "runtime limit of 300 ms" in expired["error"]


async def test_a_call_that_stalls_refuses_its_open_question(world: World) -> None:
    # No acks while it waits for the answer, and still there to hear the refusal.
    address, got = await world.asker("asker-stall", keepalive_interval_s=None)
    tools = world.tools(world.client(stream_inactivity_timeout=0.3))
    asked = call(await tools.execute("prompt_agent", {"address": address, "prompt": "go"}))
    assert asked["state"] == "input_required"
    await wait_for(lambda: bool(got), timeout_s=5, what="the refusal")
    assert got == [AGENT_TOOLS_QUESTION_REFUSAL]
    failed = call(await tools.execute("wait_agent", {"call_ids": [asked["call_id"]]}))
    assert failed["state"] == "failed"
    assert "sent nothing for 300 ms" in failed["error"]


async def test_a_question_whose_reply_look_fails_or_whose_file_cannot_be_saved_is_refused(
    world: World, tmp_path: Path
) -> None:
    class Exploding(AgentToolsExtension):
        async def after_reply(self, ctx: AgentToolsReplyContext) -> Mapping[str, Any] | None:
            if ctx.kind == "question":
                raise RuntimeError("boom")
            return None

    address, got = await world.asker("asker-look")
    tools = world.tools(extensions=[Exploding()])
    failed = call(await tools.execute("prompt_agent", {"address": address, "prompt": "go"}))
    assert failed["state"] == "failed"
    assert "an extension failed on the question: boom" in failed["error"]
    await wait_for(lambda: bool(got), timeout_s=5, what="the refusal")
    assert got == [AGENT_TOOLS_QUESTION_REFUSAL]

    # The staging directory cannot be made: its parent is a file.
    (tmp_path / "file").write_text("")
    address, got = await world.asker("asker-save")
    tools = world.tools(staging_dir=tmp_path / "file" / "staging")
    unsaved = call(await tools.execute("prompt_agent", {"address": address, "prompt": "go"}))
    assert unsaved["state"] == "failed"
    assert "a file the agent sent could not be saved" in unsaved["error"]
    await wait_for(lambda: bool(got), timeout_s=5, what="the refusal")
    assert got == [AGENT_TOOLS_QUESTION_REFUSAL]


# --- cancelling while a question is taken in -------------------------------------------


async def test_cancel_agent_refuses_a_question_still_being_taken_in_once(world: World) -> None:
    address, got = await world.asker("asker-held")
    look = HeldLook()
    tools = world.tools(extensions=[look])
    async with refusals_sent(world.nc) as wire:
        started = call(
            await tools.execute("prompt_agent", {"address": address, "prompt": "go", "wait": False})
        )
        await wait_for(lambda: look.held, what="the question to reach the reply look")
        cancelled = await tools.execute("cancel_agent", {"call_ids": [started["call_id"]]})
        assert cancelled["calls"] == [{"call_id": started["call_id"], "state": "cancelled"}]
        await wait_for(lambda: bool(got), timeout_s=5, what="the refusal")
        assert got == [AGENT_TOOLS_QUESTION_REFUSAL]
        # The reply look was cancelled with the reader: letting it go sends nothing more.
        look.released.set()
        await asyncio.sleep(0.1)
        assert len(wire) == 1
    after = call(await tools.execute("wait_agent", {"call_ids": [started["call_id"]]}))
    assert after == {"call_id": started["call_id"], "state": "cancelled", "remaining": []}


async def test_the_end_of_a_served_prompt_refuses_a_question_still_being_taken_in_once(
    world: World,
) -> None:
    address, got = await world.asker("asker-held-scope")
    look = HeldLook()
    tools = world.tools(extensions=[look])

    async def handler(_envelope: Envelope, stream: PromptStream) -> None:
        await tools.execute("prompt_agent", {"address": address, "prompt": "go", "wait": False})
        await wait_for(lambda: look.held, what="the question to reach the reply look")
        await stream.send("done")

    await world.service("host-held", handler, interceptors=[tools.request_interceptor])
    async with refusals_sent(world.nc) as wire:
        # Unsigned, as in the scope tests: the caller guard stays out of it.
        assert await serve(world.client(signed=False), "host-held") == "done"
        await wait_for(lambda: bool(got), timeout_s=5, what="the refusal")
        assert got == [AGENT_TOOLS_QUESTION_REFUSAL]
        look.released.set()
        await asyncio.sleep(0.1)
        assert len(wire) == 1


# --- scopes ----------------------------------------------------------------------------


async def test_a_served_prompts_calls_end_with_it(world: World) -> None:
    tools = world.tools()
    address = world.worker_address
    inside: list[dict[str, Any]] = []
    pending: list[asyncio.Task[dict[str, Any]]] = []

    async def handler(_envelope: Envelope, stream: PromptStream) -> None:
        asking = call(
            await tools.execute(
                "prompt_agent", {"address": address, "prompt": "ask:still there?", "wait": False}
            )
        )
        question = await tools.execute("wait_agent", {"call_ids": [asking["call_id"]]})
        running = call(
            await tools.execute(
                "prompt_agent",
                {"address": world.other_address, "prompt": "gate:scope", "wait": False},
            )
        )
        await wait_for(lambda: world.gate("scope").reached, what="the worker to start")
        await asyncio.sleep(0.05)
        listed = await tools.execute("list_agent_calls")
        inside.extend([asking, question, running, listed])
        # A wait still pending when the prompt ends.
        pending.append(
            asyncio.create_task(tools.execute("wait_agent", {"call_ids": [running["call_id"]]}))
        )
        await stream.send("done")

    await world.service("host-scope", handler, interceptors=[tools.request_interceptor])
    # Unsigned: this test's caller and the worker share a NATS user, so a
    # signed prompt would meet the caller guard.
    assert await serve(world.client(signed=False), "host-scope") == "done"

    asking, question, running, listed = inside
    assert (asking["state"], asking["open_calls"]) == ("running", 1)
    assert "end with the prompt you are answering" in asking["open_calls_note"]
    assert (question["state"], question["open_calls"]) == ("input_required", 1)
    assert running["open_calls"] == 2
    assert (listed["open_calls"], len(listed["calls"])) == (2, 2)

    # The pending wait saw its call cancelled when the prompt ended.
    ended = await pending[0]
    assert (ended["state"], ended["partial_reply"]) == ("cancelled", "partial ")
    await wait_for(
        lambda: bool(world.answers) and world.answers[-1] == AGENT_TOOLS_QUESTION_REFUSAL,
        what="the refusal",
    )
    # Outside that prompt, its calls are unknown.
    outside = await tools.execute("wait_agent", {"call_ids": [running["call_id"]]})
    assert "no such call" in outside["error"]


async def test_prompt_scope_is_the_same_scope_for_hosts_without_agent_service(
    world: World,
) -> None:
    tools = world.tools()
    async with tools.prompt_scope():
        c = call(
            await tools.execute(
                "prompt_agent",
                {"address": world.worker_address, "prompt": "gate:run", "wait": False},
            )
        )
        assert "end with the prompt you are answering" in c["open_calls_note"]
    assert c["state"] == "running"
    after = await tools.execute("wait_agent", {"call_ids": [c["call_id"]]})
    assert "no such call" in after["error"]


async def test_outside_a_served_prompt_on_settled_reports_each_call(world: World) -> None:
    settled: list[tuple[dict[str, Any], SettledInfo]] = []

    def report(result: dict[str, Any], info: SettledInfo) -> None:
        settled.append((result, info))

    tools = world.tools(on_settled=report)
    address = world.worker_address
    detached = call(
        await tools.execute(
            "prompt_agent", {"address": address, "prompt": "echo:bg", "wait": False}
        )
    )
    await wait_for(lambda: len(settled) == 1, what="the first report")
    assert settled[0] == (
        {"call_id": detached["call_id"], "state": "completed", "reply": "echo:bg"},
        SettledInfo(awaited=False),
    )
    blocking = call(await tools.execute("prompt_agent", {"address": address, "prompt": "echo:fg"}))
    await wait_for(lambda: len(settled) == 2, what="the second report")
    assert settled[1] == (blocking, SettledInfo(awaited=True))
    # Calls in a served prompt are not reported.
    async with tools.prompt_scope():
        await tools.execute("prompt_agent", {"address": address, "prompt": "echo:scoped"})
    await asyncio.sleep(0.05)
    assert len(settled) == 2


async def test_aclose_cancels_open_calls_and_removes_the_staging_directory_it_made(
    world: World,
) -> None:
    tools = AgentTools(world.client(), discover_timeout=0.25)
    files = call(
        await tools.execute("prompt_agent", {"address": world.worker_address, "prompt": "files:"})
    )
    staging = Path(files["attachments"][0]["path"]).parent.parent
    c = call(
        await tools.execute(
            "prompt_agent", {"address": world.worker_address, "prompt": "gate:close", "wait": False}
        )
    )
    await tools.aclose()
    assert not staging.exists()
    with pytest.raises(RuntimeError, match="closed"):
        await tools.execute("wait_agent", {"call_ids": [c["call_id"]]})


# --- files ----------------------------------------------------------------------------


async def test_files_are_sent_only_from_under_the_configured_roots(
    world: World, tmp_path: Path
) -> None:
    root = tmp_path / "root"
    elsewhere = tmp_path / "elsewhere"
    root.mkdir()
    elsewhere.mkdir()
    (root / "ok.txt").write_text("fine!")
    (elsewhere / "secret.txt").write_text("nope")
    os.symlink(elsewhere / "secret.txt", root / "link.txt")
    tools = world.tools(attachment_roots=[root])
    address = world.worker_address
    sent = call(
        await tools.execute(
            "prompt_agent",
            {"address": address, "prompt": "attach:", "attachments": [str(root / "ok.txt")]},
        )
    )
    assert sent["reply"] == "got:ok.txt=fine!"
    for path, words in [
        (elsewhere / "secret.txt", "outside the directories you may send files from"),
        (root / "link.txt", "outside the directories you may send files from"),
        (root / "missing.txt", "does not exist"),
        (root, "is not a file"),
    ]:
        refused = await tools.execute(
            "prompt_agent", {"address": address, "prompt": "attach:", "attachments": [str(path)]}
        )
        conforms(refused)
        assert words in refused["error"]


async def test_returned_files_are_saved_one_directory_per_call(
    world: World, tmp_path: Path
) -> None:
    staging = tmp_path / "staging"
    tools = world.tools(staging_dir=staging)
    result = call(
        await tools.execute("prompt_agent", {"address": world.worker_address, "prompt": "files:"})
    )
    call_dir = staging.resolve() / result["call_id"]
    assert result["attachments"] == [
        {"filename": "report.txt", "size_bytes": 5, "path": str(call_dir / "report.txt")},
        {"filename": "../escape.txt", "size_bytes": 1, "path": str(call_dir / "escape.txt")},
        {"filename": "bad.bin", "size_bytes": 0, "path": None, "skipped": "invalid_content"},
    ]
    assert (call_dir / "report.txt").read_text() == "hello"
    # A directory the host gave is the host's: aclose() keeps it.
    await tools.aclose()
    assert staging.is_dir()


async def test_saving_stops_at_the_total_per_call(world: World) -> None:
    tools = world.tools(max_saved_bytes_per_call=6)
    result = call(
        await tools.execute("prompt_agent", {"address": world.worker_address, "prompt": "big:"})
    )
    first, second = result["attachments"]
    assert (first["filename"], first["size_bytes"]) == ("a.txt", 5)
    assert first["path"].endswith("a.txt")
    assert second == {"filename": "b.txt", "size_bytes": 6, "path": None, "skipped": "over_limit"}


async def test_a_questions_files_are_saved_and_can_be_sent_on_from_staging(
    world: World,
) -> None:
    tools = world.tools()
    address = world.worker_address
    asked = call(await tools.execute("prompt_agent", {"address": address, "prompt": "ask-file:"}))
    assert (asked["state"], asked["question"]) == ("input_required", "look at this")
    (file,) = asked["attachments"]
    assert (file["filename"], file["size_bytes"]) == ("q.txt", 13)
    assert Path(file["path"]).read_text() == "question file"
    done = call(
        await tools.execute("answer_agent", {"call_id": asked["call_id"], "answer": "seen"})
    )
    assert done["reply"] == "answered:seen"
    # The staging directory is a default root.
    forwarded = call(
        await tools.execute(
            "prompt_agent",
            {"address": address, "prompt": "attach:", "attachments": [file["path"]]},
        )
    )
    assert forwarded["reply"] == f"got:{Path(file['path']).name}=question file"


# --- loop guards -------------------------------------------------------------------------


async def test_the_agents_own_address_is_refused_and_left_out_of_discovery(
    world: World,
) -> None:
    tools = world.tools(self_address=world.worker_address)
    refused = await tools.execute(
        "prompt_agent", {"address": world.worker_address, "prompt": "echo:me"}
    )
    conforms(refused)
    assert "your own address" in refused["error"]
    found = await tools.execute("discover_agents", {"name": "worker"})
    assert found == {"agents": []}


async def test_the_agent_whose_signed_prompt_is_served_is_refused_and_only_it(
    world: World,
) -> None:
    tools = world.tools()
    inside: list[dict[str, Any]] = []

    async def handler(_envelope: Envelope, stream: PromptStream) -> None:
        inside.append(
            await tools.execute(
                "prompt_agent", {"address": world.worker_address, "prompt": "echo:back"}
            )
        )
        await stream.send("ok")

    await world.service("host-guard", handler, interceptors=[tools.request_interceptor])
    # The worker registered alice's identity, and alice signed this prompt.
    await serve(world.client(), "host-guard")
    conforms(inside[0])
    assert "sent the prompt you are answering" in inside[0]["error"]
    # An unsigned sender cannot be matched: the guard does not apply.
    await serve(world.client(signed=False), "host-guard")
    assert (inside[1]["state"], inside[1]["reply"]) == ("completed", "echo:back")


# --- errors as results -------------------------------------------------------------------


async def test_an_unknown_address_a_refusal_and_a_stall_come_back_in_words(
    world: World,
) -> None:
    tools = world.tools()
    unknown = await tools.execute(
        "prompt_agent", {"address": "agents.prompt.nobody.o.x", "prompt": "hi"}
    )
    conforms(unknown)
    assert 'no agent answers at "agents.prompt.nobody.o.x"' in unknown["error"]

    picky = await world.service("picky", world.work, accept_sender=lambda _sender: False)
    forbidden = call(
        await tools.execute("prompt_agent", {"address": picky.subject.prompt, "prompt": "echo:x"})
    )
    assert forbidden["state"] == "failed"
    assert "answered with an error: 403" in forbidden["error"]
    unsigned = world.tools(world.client(signed=False))
    unauthorized = call(
        await unsigned.execute(
            "prompt_agent", {"address": picky.subject.prompt, "prompt": "echo:x"}
        )
    )
    assert "answered with an error: 401" in unauthorized["error"]

    async def mute(_envelope: Envelope, stream: PromptStream) -> None:
        await world.gate("mute").event.wait()
        await stream.send("late")

    quiet = await world.service("mute", mute, keepalive_interval_s=None)
    impatient = world.tools(world.client(stream_inactivity_timeout=0.3))
    stalled = call(
        await impatient.execute("prompt_agent", {"address": quiet.subject.prompt, "prompt": "hi"})
    )
    assert stalled["state"] == "failed"
    assert "sent nothing for 300 ms" in stalled["error"]

    # A tool the helper does not have, and bad arguments.
    assert await tools.execute("summon_agent", {}) == {"error": 'unknown tool "summon_agent"'}
    assert "not valid JSON" in (await tools.execute("prompt_agent", "{oops"))["error"]


# --- the tool-call ID and the extension hooks ----------------------------------------


@dataclass
class Recorder:
    """A prompt interceptor that records what each prompt's ``ctx.context`` held."""

    contexts: list[dict[str, object]] = field(default_factory=list)

    async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
        self.contexts.append(dict(ctx.context))
        return None


async def test_the_tool_call_id_reaches_a_prompt_interceptors_context(world: World) -> None:
    recorder = Recorder()
    tools = world.tools(world.client(interceptors=[recorder]))
    await tools.execute(
        "prompt_agent",
        {"address": world.worker_address, "prompt": "echo:id"},
        tool_call_id="toolu_1",
    )
    assert recorder.contexts == [{"tool_call_id": "toolu_1"}]
    # Never on the wire: the worker got the prompt alone.
    assert world.received[-1].prompt == "echo:id"
    assert world.received[-1].extras == {}


class TaggingExtension(AgentToolsExtension):
    """Uses all three hooks."""

    def __init__(self) -> None:
        self.seen: list[str] = []

    async def discovery_fields(self, agent: Agent) -> Mapping[str, Any] | None:
        return {"x_kind": f"kind:{agent.agent}"}

    async def before_prompt(self, ctx: AgentToolsPromptContext) -> AgentToolsPromptRewrite | None:
        if "forbidden" in ctx.prompt:
            return AgentToolsPromptRewrite(error="that prompt may not go out")
        return AgentToolsPromptRewrite(
            prompt=f"echo:rewritten {ctx.prompt}",
            context={"x_marker": ctx.call_id},
            fields={"x_rewritten": True},
        )

    async def after_reply(self, ctx: AgentToolsReplyContext) -> Mapping[str, Any] | None:
        self.seen.append(f"{ctx.kind}:{ctx.text}")
        return {"x_length": len(ctx.text)}


async def test_an_extensions_three_hooks_run(world: World) -> None:
    recorder = Recorder()
    extension = TaggingExtension()
    tools = world.tools(world.client(interceptors=[recorder]), extensions=[extension])

    found = await tools.execute("discover_agents", {"name": "worker"})
    assert found["agents"][0]["x_kind"] == "kind:tools-test"

    result = await tools.execute(
        "prompt_agent",
        {"address": world.worker_address, "prompt": "hello"},
        tool_call_id="toolu_2",
    )
    conforms(result, frozenset({"x_rewritten", "x_length"}))
    assert result == {
        "call_id": result["call_id"],
        "state": "completed",
        "reply": "echo:rewritten hello",
        "x_rewritten": True,
        "x_length": len("echo:rewritten hello"),
    }
    assert recorder.contexts == [{"x_marker": result["call_id"], "tool_call_id": "toolu_2"}]
    assert extension.seen == ["reply:echo:rewritten hello"]

    refused = await tools.execute(
        "prompt_agent", {"address": world.worker_address, "prompt": "forbidden"}
    )
    assert refused == {"error": "that prompt may not go out"}

    class Broken(AgentToolsExtension):
        async def before_prompt(
            self, ctx: AgentToolsPromptContext
        ) -> AgentToolsPromptRewrite | None:
            return AgentToolsPromptRewrite(fields={"state": "mine"})

    # An extension that sets a field the contract defines is a bug.
    broken = world.tools(extensions=[Broken()])
    with pytest.raises(ValueError, match='may not set "state"'):
        await broken.execute("prompt_agent", {"address": world.worker_address, "prompt": "echo:x"})


async def test_a_reply_look_that_raises_fails_the_call(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    class Exploding(AgentToolsExtension):
        async def after_reply(self, ctx: AgentToolsReplyContext) -> Mapping[str, Any] | None:
            raise RuntimeError("boom")

    tools = world.tools(extensions=[Exploding()], logger=TOOLS_LOG)
    result = call(
        await tools.execute("prompt_agent", {"address": world.worker_address, "prompt": "echo:x"})
    )
    assert (result["state"], result["partial_reply"]) == ("failed", "echo:x")
    assert "an extension failed on the reply: boom" in result["error"]
    # The extension's own failure, not a bug the helper names.
    assert errors_logged(caplog) == []


async def test_a_reply_look_that_sets_a_field_the_contract_defines_fails_and_logs(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    class Broken(AgentToolsExtension):
        async def after_reply(self, ctx: AgentToolsReplyContext) -> Mapping[str, Any] | None:
            return {"state": "mine"}

    async def ask(_envelope: Envelope, stream: PromptStream) -> None:
        # Asks, and nobody answers: the call fails on the question.
        with contextlib.suppress(Exception):
            await stream.ask("may I?", timeout=0.5)

    asker = (await world.service("asker", ask)).subject.prompt
    tools = world.tools(extensions=[Broken()], logger=TOOLS_LOG)

    def bug(kind: str, address: str) -> str:
        return (
            f'an extension of these tools has a bug (it set "state" on the {kind}, '
            f'a field the tools define); the agent at "{address}" is not at fault'
        )

    reply = call(
        await tools.execute("prompt_agent", {"address": world.worker_address, "prompt": "echo:x"})
    )
    assert (reply["state"], reply["partial_reply"]) == ("failed", "echo:x")
    assert reply["error"] == bug("reply", world.worker_address)

    question = call(await tools.execute("prompt_agent", {"address": asker, "prompt": "go"}))
    assert question["state"] == "failed"
    assert question["error"] == bug("question", asker)

    line = (
        'AgentTools: an extension bug: after_reply set "state", a field the contract '
        "defines; the call fails (call_id={}, kind={})"
    )
    assert errors_logged(caplog) == [
        line.format(reply["call_id"], "reply"),
        line.format(question["call_id"], "question"),
    ]

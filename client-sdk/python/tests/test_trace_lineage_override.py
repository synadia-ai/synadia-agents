"""An explicit ``Envelope`` may carry its own lineage.

``thread_id`` and ``root_id`` travel together on the wire, so overriding
one must not leave the other naming an unrelated tree. An overridden
thread with no root of its own starts its own tree — the same rule the
agent service applies when it adopts an ID-less envelope.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from synadia_ai.agents import Agent, Envelope, TraceOptions
from synadia_ai.agents.trace import TraceScope, bind_active_trace
from tests.test_prompt_max_wait import _make_agent_info

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

PROMPT_SUBJECT = "lineage.prompt"
THREAD = "a" * 32
ROOT = "b" * 32
AMBIENT_THREAD = "c" * 32
AMBIENT_ROOT = "d" * 32


async def _prompts(nc: NATSClient) -> list[Msg]:
    seen: list[Msg] = []

    async def cb(msg: Msg) -> None:
        seen.append(msg)
        if msg.reply:
            await nc.publish(msg.reply, b"")

    await nc.subscribe(PROMPT_SUBJECT, cb=cb)
    await nc.flush()
    return seen


async def _send(nc: NATSClient, envelope: Envelope) -> dict[str, str]:
    seen = await _prompts(nc)
    agent = Agent(nc, _make_agent_info(PROMPT_SUBJECT), trace=TraceOptions())
    async for _ in agent.prompt(envelope):
        pass
    await asyncio.sleep(0.1)
    parsed: dict[str, str] = json.loads(seen[0].data)
    return parsed


async def test_overridden_thread_id_roots_itself(nc: NATSClient) -> None:
    sent = await _send(nc, Envelope(prompt="hi", thread_id=THREAD))
    assert sent["thread_id"] == THREAD
    assert sent["root_id"] == THREAD


async def test_overridden_thread_id_stays_in_the_ambient_tree(nc: NATSClient) -> None:
    scope = TraceScope(AMBIENT_THREAD, AMBIENT_ROOT)
    with bind_active_trace(scope, None):
        sent = await _send(nc, Envelope(prompt="hi", thread_id=THREAD))
    assert sent["thread_id"] == THREAD
    assert sent["root_id"] == AMBIENT_ROOT


async def test_forwarding_the_incoming_envelope_spawns_a_new_thread(nc: NATSClient) -> None:
    """A relay hands the envelope it received straight to a sub-agent. That
    envelope names this execution's own thread; a subprompt filed under it
    would collapse two executions into one, so the minted thread stands."""
    scope = TraceScope(AMBIENT_THREAD, AMBIENT_ROOT)
    incoming = Envelope(prompt="hi", thread_id=AMBIENT_THREAD, root_id=AMBIENT_ROOT)
    with bind_active_trace(scope, None):
        sent = await _send(nc, incoming)
    assert sent["thread_id"] != AMBIENT_THREAD, "sub-agent filed under its parent's thread"
    assert sent["root_id"] == AMBIENT_ROOT


async def test_forwarding_an_envelope_with_only_the_thread_spawns_too(nc: NATSClient) -> None:
    scope = TraceScope(AMBIENT_THREAD, AMBIENT_ROOT)
    with bind_active_trace(scope, None):
        sent = await _send(nc, Envelope(prompt="hi", thread_id=AMBIENT_THREAD))
    assert sent["thread_id"] != AMBIENT_THREAD
    assert sent["root_id"] == AMBIENT_ROOT


async def test_overridden_root_id_is_honoured(nc: NATSClient) -> None:
    sent = await _send(nc, Envelope(prompt="hi", root_id=ROOT))
    assert sent["root_id"] == ROOT
    assert sent["thread_id"] != ROOT


async def test_both_overridden_are_honoured(nc: NATSClient) -> None:
    sent = await _send(nc, Envelope(prompt="hi", thread_id=THREAD, root_id=ROOT))
    assert sent["thread_id"] == THREAD
    assert sent["root_id"] == ROOT


async def test_empty_lineage_is_absent(nc: NATSClient) -> None:
    """An empty id names nothing; the prompt mints its own instead."""
    sent = await _send(nc, Envelope(prompt="hi", thread_id="", root_id=""))
    assert sent["thread_id"] not in ("", THREAD)
    assert sent["root_id"] == sent["thread_id"]


async def test_an_untraced_client_drops_the_envelope_lineage(nc: NATSClient) -> None:
    """With tracing off the extension leaves nothing on the wire, even when
    the envelope handed in carries lineage — an untraced relay forwarding
    what it received sends a plain v0.3 envelope."""
    seen = await _prompts(nc)
    agent = Agent(nc, _make_agent_info(PROMPT_SUBJECT))
    async for _ in agent.prompt(Envelope(prompt="hi", thread_id=THREAD, root_id=ROOT)):
        pass
    await asyncio.sleep(0.1)
    assert seen[0].data == b'{"prompt":"hi"}'


async def test_an_untraced_client_drops_the_lineage_even_inside_a_traced_handler(
    nc: NATSClient,
) -> None:
    """An untraced service that adopted upstream lineage binds a scope with
    no options; a client used inside it stays untraced and must not forward
    the parent's thread to the sub-agent."""
    seen = await _prompts(nc)
    scope = TraceScope(AMBIENT_THREAD, AMBIENT_ROOT)
    incoming = Envelope(prompt="hi", thread_id=AMBIENT_THREAD, root_id=AMBIENT_ROOT)
    with bind_active_trace(scope, None):
        agent = Agent(nc, _make_agent_info(PROMPT_SUBJECT))
        async for _ in agent.prompt(incoming):
            pass
    await asyncio.sleep(0.1)
    assert seen[0].data == b'{"prompt":"hi"}'

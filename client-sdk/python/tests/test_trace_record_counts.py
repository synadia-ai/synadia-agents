"""The SDK counts the trace records it published and the ones it could not.

A record that was never published leaves nothing behind, so the SDK
counts it itself: the client counts, for the whole process, and the
``AgentService`` reports both numbers on its heartbeat as
``records_published`` and ``records_dropped``. The counters are
process-wide, so every assertion here is on the delta across one prompt.
The TypeScript SDK counts the same events.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import pytest

from synadia_ai.agents import (
    Agent,
    Identity,
    TraceOptions,
    signer_from_seed,
    trace_record_counts,
)
from tests.test_prompt_max_wait import _make_agent_info

if TYPE_CHECKING:
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser, EvidenceFor, NkeyUser
    from tests.harness.nats_server import RunningServer

SUBJECT = "count.prompt"


async def _answer_prompts(nc: Any) -> None:
    async def cb(msg: Msg) -> None:
        if msg.reply:
            await nc.publish(msg.reply, b"")

    await nc.subscribe(SUBJECT, cb=cb)
    await nc.flush()


async def _drain(agent: Agent) -> None:
    # Both counters move before the prompt's first chunk arrives: the
    # signed publish is awaited immediately before the prompt goes out,
    # and the unsigned drop is counted at the same point.
    async for _ in agent.prompt("hi"):
        pass


def _signed(nc: Any, alice: NkeyUser, edge_subject: str | None = "TRACE.edges") -> Agent:
    return Agent(
        nc,
        _make_agent_info(SUBJECT),
        identity=Identity(signer=signer_from_seed(alice.seed)),
        trace=TraceOptions(edge_subject=edge_subject),
    )


async def test_a_record_handed_to_the_connection_counts_as_published(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    await _answer_prompts(nc)
    before = trace_record_counts()
    await _drain(_signed(nc, identity_keys["alice"]))
    after = trace_record_counts()
    assert after.published - before.published == 1
    assert after.dropped - before.dropped == 0


async def test_a_record_due_without_an_identity_counts_as_dropped(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    evidence_for: EvidenceFor,
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    await _answer_prompts(nc)
    agent = Agent(nc, _make_agent_info(SUBJECT), trace=TraceOptions())
    before = trace_record_counts()
    await _drain(agent)
    after = trace_record_counts()
    assert after.published - before.published == 0
    assert after.dropped - before.dropped == 1


async def test_nothing_is_counted_for_an_unsigned_prompt_that_never_goes_out(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    evidence_for: EvidenceFor,
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    agent = Agent(nc, _make_agent_info(SUBJECT), trace=TraceOptions())
    before = trace_record_counts()
    agent.prompt("hi")  # never iterated
    await asyncio.sleep(0.1)
    assert trace_record_counts() == before


async def test_a_record_whose_publish_raised_counts_as_dropped(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail-open: the record is dropped and counted, the prompt still goes out."""
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    await _answer_prompts(nc)
    real_publish = nc.publish

    async def failing(subject: str, *args: Any, **kwargs: Any) -> None:
        if subject == "TRACE.edges":
            raise RuntimeError("connection draining")
        await real_publish(subject, *args, **kwargs)

    monkeypatch.setattr(nc, "publish", failing)
    before = trace_record_counts()
    await _drain(_signed(nc, identity_keys["alice"]))
    after = trace_record_counts()
    assert after.published - before.published == 0
    assert after.dropped - before.dropped == 1


async def test_nothing_is_counted_in_propagate_only_mode(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    """No record is due, so none is published and none is dropped."""
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    await _answer_prompts(nc)
    before = trace_record_counts()
    await _drain(_signed(nc, identity_keys["alice"], edge_subject=None))
    assert trace_record_counts() == before

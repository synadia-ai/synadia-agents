"""An edge record must only ever describe a prompt that was actually sent.

It is published immediately before the prompt itself — an observer should
see the node before it runs — and not at all for a prompt that never goes
out: one whose stream is never iterated, or that local validation rejects
before any wire I/O. The TypeScript SDK has the same three guarantees.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING, Any

import pytest

from synadia_ai.agents import Agent, Identity, PayloadTooLargeError, TraceOptions, signer_from_seed
from synadia_ai.agents.identity.options import SenderHeaderPlan
from tests.test_prompt_max_wait import _make_agent_info

if TYPE_CHECKING:
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser, EvidenceFor, NkeyUser
    from tests.harness.nats_server import RunningServer

SUBJECT = "probe2.prompt"


async def _sub(nc: Any, subject: str, out: list[str], label: str, *, reply: bool = False) -> None:
    async def cb(msg: Msg) -> None:
        out.append(label)
        if reply and msg.reply:
            await nc.publish(msg.reply, b"")

    await nc.subscribe(subject, cb=cb)
    await nc.flush()


async def _traced(nc: Any, alice: NkeyUser, info: Any = None) -> Agent:
    return Agent(
        nc,
        info or _make_agent_info(SUBJECT),
        identity=Identity(signer=signer_from_seed(alice.seed)),
        trace=TraceOptions(),
    )


async def test_edge_precedes_the_prompt(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    order: list[str] = []
    await _sub(nc, "TRACE.edges", order, "edge")
    await _sub(nc, SUBJECT, order, "prompt", reply=True)
    agent = await _traced(nc, identity_keys["alice"])
    async for _ in agent.prompt("hi"):
        pass
    await asyncio.sleep(0.3)
    assert order == ["edge", "prompt"], order


async def test_edge_is_stamped_when_the_prompt_goes_out(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    """``ts`` says when the prompt was sent — not when it was planned."""
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    records: list[dict[str, Any]] = []

    async def on_edge(msg: Msg) -> None:
        records.append(json.loads(msg.data))

    await nc.subscribe("TRACE.edges", cb=on_edge)
    await _sub(nc, SUBJECT, [], "prompt", reply=True)
    agent = await _traced(nc, identity_keys["alice"])

    stream = agent.prompt("hi")  # planned now …
    await asyncio.sleep(1.1)  # … a whole second passes …
    sent_at = int(time.time())
    async for _ in stream:  # … sent now
        pass
    await asyncio.sleep(0.3)
    assert len(records) == 1, records
    assert records[0]["ts"] >= sent_at, (records[0]["ts"], sent_at)


async def test_no_edge_when_the_stream_is_never_iterated(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    order: list[str] = []
    await _sub(nc, "TRACE.edges", order, "edge")
    agent = await _traced(nc, identity_keys["alice"])
    agent.prompt("hi")  # never iterated
    await asyncio.sleep(0.3)
    assert order == [], order


async def test_no_edge_when_the_prompt_header_cannot_be_built(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The prompt's header is signed at publish time, immediately before
    the request goes out, and signing can fail. Fail it for the prompt
    payload only — the edge record's own header is left alone, so the edge
    WOULD go out if it were published first."""
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    order: list[str] = []
    await _sub(nc, "TRACE.edges", order, "edge")
    await _sub(nc, SUBJECT, order, "prompt", reply=True)

    real = SenderHeaderPlan.build_headers

    async def failing(self: SenderHeaderPlan, payload: bytes) -> dict[str, str]:
        if payload.startswith(b'{"prompt"'):
            raise RuntimeError("signer unavailable")
        return await real(self, payload)

    monkeypatch.setattr(SenderHeaderPlan, "build_headers", failing)

    agent = await _traced(nc, identity_keys["alice"])
    with pytest.raises(RuntimeError, match="signer unavailable"):
        async for _ in agent.prompt("hi"):
            pass
    await asyncio.sleep(0.3)
    assert order == [], order


async def test_no_edge_when_validation_rejects_the_prompt(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    evidence_for: EvidenceFor,
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await evidence_for(nc)
    order: list[str] = []
    await _sub(nc, "TRACE.edges", order, "edge")
    info = _make_agent_info(SUBJECT)
    agent = await _traced(nc, identity_keys["alice"], info)
    with pytest.raises(PayloadTooLargeError):
        stream = agent.prompt("x" * 2_000_000)
        async for _ in stream:
            pass
    await asyncio.sleep(0.3)
    assert order == [], order

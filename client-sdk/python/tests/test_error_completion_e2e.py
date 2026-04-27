"""End-to-end coverage of §9.3 error completion.

An error-terminated stream MUST consist of two messages published to the
reply subject: first an error-headered frame (§9.1), then the zero-byte
headerless terminator (§6.5). This test provokes the error path from both
sides — a malformed envelope (agent-side ``400``) and a handler exception
(``500``) — then inspects the raw wire bytes captured on the reply inbox
to confirm both messages are present in order.

The client-facing surface raises :class:`ProtocolError` on the error frame
and does not re-raise when the trailing terminator arrives; the
subscription on the reply subject picks them up directly for assertions.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import pytest

from natsagent import Agents, AgentService, Envelope, PromptStream
from natsagent.errors import ProtocolError

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"
OWNER = "pytest"
HEARTBEAT_INTERVAL_S = 30  # Long enough to never fire mid-test.


async def _collect_replies(nc: NATSClient, subject: str, inbox: str) -> list[Msg]:
    """Publish a prompt to `subject` and collect every reply that arrives."""
    sub = await nc.subscribe(inbox)
    try:
        await nc.publish(subject, b"hi", reply=inbox)
        collected: list[Msg] = []
        # Two messages expected per §9.3 (error frame + terminator); allow a
        # generous window so flakiness from scheduler jitter doesn't mask the
        # assertion failure we actually want.
        deadline = asyncio.get_event_loop().time() + 1.0
        while asyncio.get_event_loop().time() < deadline:
            try:
                msg = await sub.next_msg(timeout=0.3)
            except TimeoutError:
                break
            collected.append(msg)
            if len(collected) >= 2 and msg.data == b"" and not msg.headers:
                break
        return collected
    finally:
        await sub.unsubscribe()


@pytest.mark.asyncio
async def test_handler_exception_emits_error_then_terminator(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """500 path: handler raises → wire shows error frame followed by terminator."""

    async def _boom(envelope: Envelope, stream: PromptStream) -> None:
        raise RuntimeError("kaboom")

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name="raises",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    service.on_prompt(_boom)
    await service.start()

    try:
        messages = await _collect_replies(nc, service.subject.inbox, nc.new_inbox())
        evidence.write_jsonl(
            "wire.jsonl",
            [
                {
                    "headers": dict(msg.headers or {}),
                    "data_len": len(msg.data),
                    "data_preview": msg.data[:200].decode("utf-8", errors="replace"),
                }
                for msg in messages
            ],
        )

        # §9.3: two messages — error frame, then terminator.
        assert len(messages) == 2, (
            f"expected 2 wire messages (error + terminator); got {len(messages)}"
        )
        error_msg, terminator = messages

        # Error frame carries both service-error headers.
        error_headers = error_msg.headers or {}
        assert error_headers.get("Nats-Service-Error-Code") == "500"
        assert "kaboom" in error_headers.get("Nats-Service-Error", "")

        # Terminator: zero-byte body, NO headers (§6.5).
        assert terminator.data == b""
        assert not terminator.headers, (
            f"terminator MUST carry no headers; saw {dict(terminator.headers or {})!r}"
        )

        # Client-facing surface raises ProtocolError on the error frame.
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)
            with pytest.raises(ProtocolError, match="500"):
                async for _ in agent.prompt("trigger", timeout=5.0):
                    pass
        finally:
            await agents.close()
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_malformed_envelope_emits_400_then_terminator(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """400 path: ``{}`` (missing ``prompt``) triggers decode error → 400 + terminator."""

    async def _never_called(envelope: Envelope, stream: PromptStream) -> None:
        raise AssertionError("handler MUST NOT run on malformed envelope")

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name="strict",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    service.on_prompt(_never_called)
    await service.start()

    try:
        inbox = nc.new_inbox()
        sub = await nc.subscribe(inbox)
        try:
            # Send JSON that passes the §5.3 "starts with {" test but lacks the
            # required `prompt` field — the agent MUST reject with 400.
            await nc.publish(service.subject.inbox, b'{"no_prompt":true}', reply=inbox)
            collected = []
            deadline = asyncio.get_event_loop().time() + 1.0
            while asyncio.get_event_loop().time() < deadline:
                try:
                    msg = await sub.next_msg(timeout=0.3)
                except TimeoutError:
                    break
                collected.append(msg)
                if len(collected) >= 2 and msg.data == b"" and not msg.headers:
                    break
        finally:
            await sub.unsubscribe()

        evidence.write_jsonl(
            "wire.jsonl",
            [
                {
                    "headers": dict(msg.headers or {}),
                    "data_len": len(msg.data),
                }
                for msg in collected
            ],
        )

        assert len(collected) == 2
        error_msg, terminator = collected
        assert (error_msg.headers or {}).get("Nats-Service-Error-Code") == "400"
        assert terminator.data == b""
        assert not terminator.headers
    finally:
        await service.stop()

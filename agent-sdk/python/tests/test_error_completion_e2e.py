"""End-to-end coverage of §9.3 error completion.

An error-terminated stream ends with an error-headered frame (§9.1)
followed by the zero-byte headerless terminator (§6.5). On the handler-
exception (``500``) path the SDK has already emitted a §6.4 leading ack
before the handler ran, so the full wire shape is ``ack → error(500) →
terminator``. On the malformed-envelope (``400``) path the decode fails
before any ack would be emitted, so the wire is just ``error(400) →
terminator``. This test provokes both paths and inspects the raw wire
bytes captured on the reply inbox.

The client-facing surface raises :class:`ProtocolError` on the error frame
and does not re-raise when the trailing terminator arrives; the
subscription on the reply subject picks them up directly for assertions.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

import pytest
from synadia_ai.agents import Agents, Envelope, encode
from synadia_ai.agents.errors import ProtocolError

from synadia_ai.agent_service import AgentService, PromptStream

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"
OWNER = "pytest"
HEARTBEAT_INTERVAL_S = 30  # Long enough to never fire mid-test.


async def _collect_replies(
    nc: NATSClient,
    subject: str,
    inbox: str,
    payload: bytes = b"hi",
) -> list[Msg]:
    """Publish ``payload`` to ``subject`` and collect every reply that arrives.

    Stops once the §6.5 empty-body, no-headers terminator arrives — the
    list is always terminated by the terminator on a well-behaved agent.
    Defaults to a bare-string request (`b"hi"`) which is promoted to
    `{"prompt": "hi"}` per §5.3; pass an explicit ``payload`` (e.g. a
    malformed JSON object) to drive the 400 path.
    """
    sub = await nc.subscribe(inbox)
    try:
        await nc.publish(subject, payload, reply=inbox)
        collected: list[Msg] = []
        deadline = asyncio.get_event_loop().time() + 1.0
        while asyncio.get_event_loop().time() < deadline:
            try:
                msg = await sub.next_msg(timeout=0.3)
            except TimeoutError:
                break
            collected.append(msg)
            if msg.data == b"" and not msg.headers:
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
        session_name="raises",
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

        # §6.4 + §9.3: leading ack, then error frame, then terminator. The
        # ack is emitted before the handler runs, so even a handler that
        # raises immediately gets the leading-ack prefix on the wire.
        assert len(messages) == 3, (
            f"expected 3 wire messages (ack + error + terminator); got {len(messages)}: "
            f"{[(dict(m.headers or {}), m.data[:80]) for m in messages]!r}"
        )
        ack_msg, error_msg, terminator = messages

        # First frame: §6.4 leading ack — no headers, status=ack payload.
        assert not ack_msg.headers, (
            f"leading ack MUST NOT carry NATS headers; saw {dict(ack_msg.headers or {})!r}"
        )
        assert json.loads(ack_msg.data) == {"type": "status", "data": "ack"}, (
            f"first frame must be the §6.4 leading ack, got: {ack_msg.data!r}"
        )

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
        session_name="strict",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    service.on_prompt(_never_called)
    await service.start()

    try:
        # JSON that passes the §5.3 "starts with {" promotion check but lacks
        # the required `prompt` field — the agent MUST reject with 400 before
        # the handler runs and before any §6.4 leading ack would be emitted.
        collected = await _collect_replies(
            nc,
            service.subject.inbox,
            nc.new_inbox(),
            payload=b'{"no_prompt":true}',
        )

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

        # Exactly 2 frames: §9.1 error frame + §6.5 terminator. NO leading
        # ack — the ack lives after decode validation, and decode fails here.
        assert len(collected) == 2, (
            f"expected 2 frames (error + terminator); got {len(collected)}: "
            f"{[(dict(m.headers or {}), m.data[:80]) for m in collected]!r}"
        )
        error_msg, terminator = collected
        assert (error_msg.headers or {}).get("Nats-Service-Error-Code") == "400"
        assert terminator.data == b""
        assert not terminator.headers
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_attachments_false_rejects_before_ack(nc: NATSClient) -> None:
    """Server-side capability enforcement: attachments_ok=false returns 400 before handler."""

    async def _never_called(envelope: Envelope, stream: PromptStream) -> None:
        raise AssertionError("handler MUST NOT run when attachments_ok=false")

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="no-attachments",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
        attachments_ok=False,
    )
    service.on_prompt(_never_called)
    await service.start()

    try:
        collected = await _collect_replies(
            nc,
            service.subject.inbox,
            nc.new_inbox(),
            payload=b'{"prompt":"hi","attachments":[{"filename":"x.txt","content":"aGk="}]}',
        )

        assert len(collected) == 2
        error_msg, terminator = collected
        headers = error_msg.headers or {}
        assert headers.get("Nats-Service-Error-Code") == "400"
        assert "attachments" in headers.get("Nats-Service-Error", "")
        assert terminator.data == b""
        assert not terminator.headers
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_max_payload_rejects_before_ack(nc: NATSClient) -> None:
    """Agent-side lower max_payload override is enforced before the handler runs."""

    async def _never_called(envelope: Envelope, stream: PromptStream) -> None:
        raise AssertionError("handler MUST NOT run on oversized prompt")

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="tiny-payload",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
        max_payload="32B",
    )
    service.on_prompt(_never_called)
    await service.start()

    try:
        payload = encode(Envelope(prompt="this payload is definitely larger than thirty-two bytes"))
        assert len(payload) > 32
        collected = await _collect_replies(
            nc,
            service.subject.inbox,
            nc.new_inbox(),
            payload=payload,
        )

        assert len(collected) == 2
        error_msg, terminator = collected
        assert (error_msg.headers or {}).get("Nats-Service-Error-Code") == "413"
        assert terminator.data == b""
        assert not terminator.headers
    finally:
        await service.stop()

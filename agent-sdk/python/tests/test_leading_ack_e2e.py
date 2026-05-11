"""End-to-end coverage of the §6.4 leading-ack requirement.

Spec §6.4 (clarified 2026-05): agents MUST emit exactly one
``{"type":"status","data":"ack"}`` chunk as the **first** message on the
reply subject, before any ``response``/``query`` chunk and before any
work that introduces observable latency. The ack confirms request
receipt, resets the caller's §6.6 inactivity timeout ahead of any
warm-up gap, and makes the stream observable to generic NATS tooling
(``nats req --wait-for-empty``).

Two integration scenarios:

* **happy path** — a handler that emits one response chunk; the wire
  trace shows ``status=ack`` first, then the handler's response, then
  the §6.5 terminator.
* **malformed envelope** — the 400 path runs before any ack would be
  emitted, so a request that fails decode produces just ``error(400)``
  + terminator with no ack frame.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

import pytest
from synadia_ai.agents import Envelope, ResponseChunk, StatusChunk
from synadia_ai.agents.messages import decode_chunk

from synadia_ai.agent_service import AgentService, PromptStream

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"
OWNER = "pytest"
# Long heartbeat — keeps the wire trace focused on the prompt/reply path.
HEARTBEAT_INTERVAL_S = 30


async def _drain_reply(
    nc: NATSClient,
    subject: str,
    inbox: str,
    payload: bytes,
    timeout: float = 2.0,
) -> list[Msg]:
    """Publish ``payload`` to ``subject`` and collect every reply on ``inbox``.

    Stops once the §6.5 empty-body, no-headers terminator arrives, so the
    returned list always ends with the terminator on a well-behaved agent.
    """
    sub = await nc.subscribe(inbox)
    try:
        await nc.publish(subject, payload, reply=inbox)
        collected: list[Msg] = []
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            try:
                msg = await sub.next_msg(timeout=0.5)
            except TimeoutError:
                break
            collected.append(msg)
            if msg.data == b"" and not msg.headers:
                break
        return collected
    finally:
        await sub.unsubscribe()


@pytest.mark.asyncio
async def test_prompt_emits_leading_ack(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """§6.4: the FIRST frame on the reply subject MUST be ``status=ack``."""

    async def _echo(envelope: Envelope, stream: PromptStream) -> None:
        await stream.send(envelope.prompt)

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="leading-ack",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
        # Disable the keep-alive loop — its acks are emitted AFTER the
        # configured interval and so can't conflate with the leading ack
        # under test. The leading-ack emit path is independent of this flag.
        keepalive_interval_s=None,
    )
    service.on_prompt(_echo)
    await service.start()

    try:
        frames = await _drain_reply(
            nc, service.subject.inbox, nc.new_inbox(), b'{"prompt":"hello"}'
        )
        evidence.write_jsonl(
            "frames.jsonl",
            [
                {
                    "headers": dict(msg.headers or {}),
                    "data_len": len(msg.data),
                    "data_preview": msg.data[:200].decode("utf-8", errors="replace"),
                }
                for msg in frames
            ],
        )

        # Expected wire shape: ack, response, terminator.
        assert len(frames) == 3, (
            f"expected 3 frames (ack + response + terminator); got {len(frames)}: "
            f"{[(dict(m.headers or {}), m.data[:80]) for m in frames]!r}"
        )

        ack_msg, response_msg, terminator = frames

        # First frame: the §6.4 leading ack.
        ack_chunk = decode_chunk(ack_msg.data)
        assert isinstance(ack_chunk, StatusChunk), (
            f"first frame must be a StatusChunk; got {type(ack_chunk).__name__}: "
            f"{ack_msg.data!r}"
        )
        assert ack_chunk.status == "ack", (
            f"leading status chunk must carry status=ack; got status={ack_chunk.status!r}"
        )
        assert not ack_msg.headers, (
            f"leading ack MUST NOT carry NATS headers; saw {dict(ack_msg.headers or {})!r}"
        )

        # Second frame: the handler's response.
        response_chunk = decode_chunk(response_msg.data)
        assert isinstance(response_chunk, ResponseChunk), (
            f"second frame must be a ResponseChunk; got {type(response_chunk).__name__}"
        )
        assert response_chunk.text == "hello"

        # Third frame: §6.5 terminator (empty body, no headers).
        assert terminator.data == b""
        assert not terminator.headers

        # Sanity check the JSON wire shape literally — the evidence file is
        # the human-readable trace, but pin the bytes here so a future refactor
        # of `encode_chunk` can't silently shift the shape.
        assert json.loads(ack_msg.data) == {"type": "status", "data": "ack"}
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_malformed_prompt_no_ack_before_400(
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    """§6.4 + §9.3: the leading ack lives AFTER decode validation.

    A request that fails decode never reaches the handler, and so never
    emits an ack. The wire is exactly ``error(400)`` + terminator. This
    pins down that the SDK's leading-ack emit isn't moved above the
    decode block by a future refactor — otherwise generic NATS tooling
    would see a misleading "stream looks healthy" ack on a request that
    the agent rejected.
    """

    async def _never_called(envelope: Envelope, stream: PromptStream) -> None:
        raise AssertionError("handler MUST NOT run on malformed envelope")

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="leading-ack-400",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
        keepalive_interval_s=None,
    )
    service.on_prompt(_never_called)
    await service.start()

    try:
        # `{"no_prompt":true}` passes the §5.3 "starts with {" promotion check
        # but lacks the required `prompt` field, so decode raises and the agent
        # MUST short-circuit with 400 before any ack would be emitted.
        frames = await _drain_reply(
            nc, service.subject.inbox, nc.new_inbox(), b'{"no_prompt":true}'
        )
        evidence.write_jsonl(
            "frames.jsonl",
            [
                {
                    "headers": dict(msg.headers or {}),
                    "data_len": len(msg.data),
                    "data_preview": msg.data[:200].decode("utf-8", errors="replace"),
                }
                for msg in frames
            ],
        )

        assert len(frames) == 2, (
            f"expected 2 frames (error + terminator); got {len(frames)}: "
            f"{[(dict(m.headers or {}), m.data[:80]) for m in frames]!r}"
        )
        error_msg, terminator = frames

        # First frame: §9.1 error frame with 400.
        assert (error_msg.headers or {}).get("Nats-Service-Error-Code") == "400"

        # And critically: no ack snuck in before the error.
        decoded = decode_chunk(error_msg.data) if error_msg.data else None
        assert not isinstance(decoded, StatusChunk) or decoded.status != "ack", (
            f"a 400-rejected request MUST NOT emit a leading ack; "
            f"first frame decoded as: {decoded!r}"
        )

        # Second frame: §6.5 terminator.
        assert terminator.data == b""
        assert not terminator.headers
    finally:
        await service.stop()

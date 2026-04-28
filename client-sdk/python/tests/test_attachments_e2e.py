"""End-to-end attachment round-trip — proves the base64 boundary works live.

A client sends a prompt with an attachment; the agent echoes the received
attachment back inside a ``ResponseChunk``'s ``attachments`` list alongside
a short textual summary. The client asserts the round-tripped bytes are
byte-for-byte identical (and SHA-256-equal) to what was sent. Evidence
artifacts capture the outbound envelope (showing the base64 ``content``
field), the inbound chunk stream, and the bytes-intact proof in
``assertions.json``.

Two test cases cover both :class:`Attachment` construction paths:

- ``test_attachment_roundtrip_from_bytes`` — ``Attachment.from_bytes(...)``.
- ``test_attachment_roundtrip_from_path`` — ``Attachment.from_path(...)``,
  which also verifies basename-only filename behavior.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from synadia_ai.agents import (
    Agents,
    AgentService,
    Attachment,
    Envelope,
    PromptStream,
    ResponseChunk,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"
OWNER = "pytest"
NAME = "echo-file"

# Deterministic 1024-byte payload — well under §2.1's 1 MB default max_payload
# and nontrivial (covers every byte value 0x00-0xff four times).
PAYLOAD = bytes(range(256)) * 4
PAYLOAD_SHA256 = hashlib.sha256(PAYLOAD).hexdigest()


async def _echo_attachment(envelope: Envelope, stream: PromptStream) -> None:
    """Prompt handler: echo the first attachment back in a ResponseChunk.

    The response chunk carries the attachment verbatim plus a textual summary
    so the test can assert the handler actually ran.
    """
    assert envelope.attachments, "expected at least one attachment in the envelope"
    att = envelope.attachments[0]
    summary = f"received {len(att.to_bytes())} bytes"
    await stream.send(ResponseChunk(text=summary, attachments=[att]))


async def _run_roundtrip(
    nc: NATSClient,
    evidence: EvidenceRecorder,
    attachment: Attachment,
    prompt_text: str,
) -> None:
    """Drive one round-trip: start agent, send prompt+attachment, assert bytes intact."""
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name=NAME,
        nc=nc,
        description="integration-test file-echo agent",
    )
    service.on_prompt(_echo_attachment)
    await service.start()

    try:
        # Build the envelope exactly as Agent.prompt would — dumping it
        # for evidence BEFORE it hits the wire lets reviewers see the base64
        # `content` field without having to decode `messages.jsonl`.
        outbound = Envelope(prompt=prompt_text, attachments=[attachment])
        evidence.write_json("request-envelope.json", json.loads(outbound.model_dump_json()))

        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)

            received: list[ResponseChunk] = []
            async for msg in agent.prompt(prompt_text, attachments=[attachment], timeout=5.0):
                assert isinstance(msg, ResponseChunk), (
                    f"unexpected chunk type: {type(msg).__name__}"
                )
                received.append(msg)

            evidence.write_jsonl(
                "chunks.jsonl",
                [json.loads(chunk.model_dump_json()) for chunk in received],
            )

            # Exactly one ResponseChunk: summary text + one attachment.
            assert len(received) == 1, f"expected 1 chunk, got {len(received)}"
            chunk = received[0]
            assert chunk.attachments is not None
            assert len(chunk.attachments) == 1
            received_att = chunk.attachments[0]

            raw_bytes = attachment.to_bytes()
            assert received_att.filename == attachment.filename
            assert chunk.text == f"received {len(raw_bytes)} bytes"
            assert "received 1024 bytes" in chunk.text

            received_bytes = received_att.to_bytes()
            received_sha = hashlib.sha256(received_bytes).hexdigest()
            evidence.write_json(
                "assertions.json",
                {
                    "sent_len": len(raw_bytes),
                    "sent_sha256": hashlib.sha256(raw_bytes).hexdigest(),
                    "received_len": len(received_bytes),
                    "received_sha256": received_sha,
                    "equal": received_bytes == raw_bytes,
                },
            )
            assert received_bytes == raw_bytes, (
                "bytes differ after round-trip (wire base64 or handler mutation)"
            )
            assert received_sha == PAYLOAD_SHA256
        finally:
            await agents.close()
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_attachment_roundtrip_from_bytes(nc: NATSClient, evidence: EvidenceRecorder) -> None:
    attachment = Attachment.from_bytes("payload.bin", PAYLOAD)
    await _run_roundtrip(nc, evidence, attachment, prompt_text="please echo this blob")


@pytest.mark.asyncio
async def test_attachment_roundtrip_from_path(
    nc: NATSClient, evidence: EvidenceRecorder, tmp_path: Path
) -> None:
    # Nested path verifies `from_path` strips the directory (basename only).
    blob = tmp_path / "nested" / "blob.bin"
    blob.parent.mkdir(parents=True)
    blob.write_bytes(PAYLOAD)

    attachment = Attachment.from_path(blob)
    assert attachment.filename == "blob.bin", (
        "from_path must keep only the basename — no directory leakage"
    )
    await _run_roundtrip(nc, evidence, attachment, prompt_text="please echo this file")

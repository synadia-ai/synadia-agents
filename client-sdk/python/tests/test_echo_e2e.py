"""End-to-end echo test — the "proof of harness" integration test.

Spins up a real nats-server, registers an echo agent, connects a client,
prompts the agent, and verifies:

- the streamed response arrives in typed chunks and terminates with an empty payload
- ``$SRV.INFO.SynadiaAgents`` reports spec §3.2 metadata (``agent``,
  ``owner``, ``protocol_version``) on the shared service name
- a heartbeat is published on ``.heartbeat`` within the agent's configured interval

All observations are captured to ``tests/_evidence/<testname>/`` — a reviewer
can inspect those files and verify protocol compliance by eye.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

import pytest

from natsagent import (
    Agent,
    Client,
    Envelope,
    PromptStream,
    ResponseChunk,
)
from natsagent.heartbeat import HeartbeatPayload

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"  # NOT 'pysdk' — CLAUDE.md forbids the SDK owning an agent id.
OWNER = "pytest"
NAME = "echo"
HEARTBEAT_INTERVAL_S = 1  # Short enough to verify a beacon within the test window.


async def _echo(envelope: Envelope, stream: PromptStream) -> None:
    """Prompt handler that echoes the incoming envelope's prompt text back."""
    await stream.send(envelope.prompt)


@pytest.mark.asyncio
async def test_echo_agent_roundtrip(  # noqa: PLR0915 — integration test intentionally covers §3, §4, §6, §8 end-to-end
    nc: NATSClient, evidence: EvidenceRecorder
) -> None:
    agent = Agent(
        agent=AGENT,
        owner=OWNER,
        name=NAME,
        nc=nc,
        description="integration-test echo agent",
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    agent.on_prompt(_echo)
    await agent.start()

    try:
        # Capture an $SRV.INFO response for evidence and verify registration metadata.
        # §3.1: all compliant agents share service name "SynadiaAgents" (compact
        # form; the canonical "Synadia Agents" is equivalent but contains a space
        # and is therefore unusable in a NATS subject).
        srv_info = await nc.request("$SRV.INFO.SynadiaAgents", b"", timeout=2.0)
        srv_info_parsed = json.loads(srv_info.data)
        evidence.write_json("srv-info.json", srv_info_parsed)
        assert srv_info_parsed["name"] == "SynadiaAgents"
        # §3.2: metadata shape.
        assert srv_info_parsed["metadata"]["agent"] == AGENT
        assert srv_info_parsed["metadata"]["owner"] == OWNER
        assert srv_info_parsed["metadata"]["protocol_version"] == "0.1"
        # Spec §3.2 forbids echoing the instance name into metadata.
        assert "name" not in srv_info_parsed["metadata"]
        # And the removed v0.0.1-era keys MUST be gone.
        assert "type" not in srv_info_parsed["metadata"]
        assert "platform" not in srv_info_parsed["metadata"]
        assert "protocol" not in srv_info_parsed["metadata"]

        # §2.1: prompt endpoint declares capability metadata. On the wire it's
        # Record<string,string>, so attachments_ok is "true"/"false".
        prompt_ep = next(ep for ep in srv_info_parsed["endpoints"] if ep["name"] == "prompt")
        assert prompt_ep["subject"] == agent.subject.inbox
        assert prompt_ep["metadata"]["max_payload"] == "1MB"
        assert prompt_ep["metadata"]["attachments_ok"] == "true"

        client = Client(nc=nc)
        await client.start()

        found = await client.discover(timeout=1.0)
        inboxes = [d.inbox for d in found]
        assert agent.subject.inbox in inboxes, f"agent not discovered; saw: {inboxes}"
        # §4.3 + §2.1: the discovered record MUST surface the parsed endpoint
        # capability metadata so callers can enforce §5.4 locally.
        discovered = next(d for d in found if d.inbox == agent.subject.inbox)
        assert discovered.prompt_endpoint.name == "prompt"
        assert discovered.prompt_endpoint.subject == agent.subject.inbox
        assert discovered.prompt_endpoint.max_payload_bytes == 1024 * 1024
        assert discovered.prompt_endpoint.attachments_ok is True

        remote = client.bind(agent.subject.inbox)
        received: list[ResponseChunk] = []
        async for msg in remote.prompt("hello world", timeout=5.0):
            assert isinstance(msg, ResponseChunk), f"unexpected chunk type: {type(msg).__name__}"
            received.append(msg)

        # The iterator returning normally means the empty-payload terminator arrived (§6.5).
        assert len(received) == 1, f"expected 1 chunk, got {len(received)}"
        assert received[0].text == "hello world"
        assert received[0].attachments is None
        evidence.write_jsonl(
            "chunks.jsonl",
            [json.loads(chunk.model_dump_json()) for chunk in received],
        )

        # Wait up to 3x interval for a heartbeat to show up in the tracker.
        deadline = asyncio.get_event_loop().time() + 3 * HEARTBEAT_INTERVAL_S
        status = client.status(agent.subject.inbox)
        while status.last_seen is None and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.1)
            status = client.status(agent.subject.inbox)
        assert status.last_seen is not None, "no heartbeat observed within 3x interval"
        assert status.interval_s == HEARTBEAT_INTERVAL_S

        # Capture the literal heartbeat off the wire so the evidence file
        # reflects what the agent actually published — including the §8.3
        # fields (`agent`, `owner`, `instance_id`). A subscribe-then-wait is
        # simpler than reconstructing the payload from tracker state; the
        # first beacon has already landed, so the next one arrives within
        # one `HEARTBEAT_INTERVAL_S` window.
        hb_sub = await nc.subscribe(agent.subject.heartbeat)
        try:
            hb_msg = await hb_sub.next_msg(timeout=HEARTBEAT_INTERVAL_S * 2)
        finally:
            await hb_sub.unsubscribe()
        hb_payload = HeartbeatPayload.model_validate_json(hb_msg.data)
        evidence.write_json("heartbeat.json", json.loads(hb_payload.model_dump_json()))
        assert hb_payload.agent == AGENT
        assert hb_payload.owner == OWNER
        assert hb_payload.instance_id, "heartbeat MUST carry instance_id (§8.3)"
        assert hb_payload.interval_s == HEARTBEAT_INTERVAL_S

        assert await client.ping(agent.subject.inbox, timeout=1.0) is True

        await client.stop()
    finally:
        await agent.stop()

"""End-to-end tests for mid-stream queries (protocol §7).

Exercises the three lifecycle paths described in §7.3:

- Happy path: agent asks once, caller replies, agent continues streaming.
- Concurrent: agent asks twice via ``asyncio.gather``, each round-trip uses a
  distinct ``reply_subject`` and distinct query ``id``.
- Timeout: caller never replies; the agent catches :class:`QueryTimeout` and
  proceeds with a sensible default, terminating the stream cleanly.

Evidence is written to ``tests/_evidence/<testname>/``. The recorder's
``messages.jsonl`` captures the full wire trace (prompt envelope, query
chunks, replies, response chunks, terminator). ``chunks.jsonl`` snapshots
what the client iterator yielded for each test.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

import pytest

from natsagent import (
    Agents,
    AgentService,
    Envelope,
    PromptStream,
    Query,
    QueryTimeout,
    ResponseChunk,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder


AGENT = "test"
OWNER = "pytest"
HEARTBEAT_INTERVAL_S = 30  # Long enough that no beacon fires during the test.


def _snapshot(msg: ResponseChunk | Query | Any) -> dict[str, object]:
    """Render an async-iterator item to a JSON-safe dict for evidence capture."""
    if isinstance(msg, Query):
        return {
            "type": "query",
            "id": msg.id,
            "reply_subject": msg.reply_subject,
            "prompt": msg.prompt,
            "attachments": (
                [json.loads(a.model_dump_json()) for a in msg.attachments]
                if msg.attachments
                else None
            ),
        }
    return dict(json.loads(msg.model_dump_json()))


@pytest.mark.asyncio
async def test_query_happy_path(nc: NATSClient, evidence: EvidenceRecorder) -> None:
    """Agent asks once; caller replies "yes"; agent continues and terminates."""

    async def _confirm(envelope: Envelope, stream: PromptStream) -> None:
        await stream.send("thinking…")
        answer = await stream.ask("Proceed? (yes/no)", timeout=5.0)
        assert isinstance(answer, Envelope)
        if answer.prompt.strip().lower() == "yes":
            await stream.send("done")
        else:
            await stream.send("aborted")

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name="confirm",
        nc=nc,
        description="confirmation agent",
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    service.on_prompt(_confirm)
    await service.start()

    try:
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)

            messages: list[ResponseChunk | Query | object] = []
            async for msg in agent.prompt("run it", timeout=5.0):
                messages.append(msg)
                if isinstance(msg, Query):
                    await msg.reply("yes")

            evidence.write_jsonl("chunks.jsonl", [_snapshot(m) for m in messages])

            assert len(messages) == 3, f"expected 3 yielded items, got {len(messages)}"
            first, second, third = messages
            assert isinstance(first, ResponseChunk)
            assert first.text == "thinking…"

            assert isinstance(second, Query)
            assert second.id, "query id must be non-empty"
            assert second.reply_subject.startswith("_INBOX."), (
                f"reply_subject should be a NATS inbox; got {second.reply_subject!r}"
            )
            assert second.prompt == "Proceed? (yes/no)"

            assert isinstance(third, ResponseChunk)
            assert third.text == "done"
        finally:
            await agents.close()
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_query_concurrent_asks(nc: NATSClient, evidence: EvidenceRecorder) -> None:
    """``asyncio.gather`` of two ``ask`` calls — each gets its own inbox + id."""

    async def _two_at_once(envelope: Envelope, stream: PromptStream) -> None:
        a, b = await asyncio.gather(
            stream.ask("A?", timeout=5.0),
            stream.ask("B?", timeout=5.0),
        )
        await stream.send(f"{a.prompt}|{b.prompt}")

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name="pair",
        nc=nc,
        description="concurrent-query agent",
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    service.on_prompt(_two_at_once)
    await service.start()

    replies = {"A?": "answer-a", "B?": "answer-b"}

    try:
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)

            messages: list[ResponseChunk | Query | object] = []
            queries: list[Query] = []
            async for msg in agent.prompt("kick off", timeout=5.0):
                messages.append(msg)
                if isinstance(msg, Query):
                    queries.append(msg)
                    await msg.reply(replies[msg.prompt])

            evidence.write_jsonl("chunks.jsonl", [_snapshot(m) for m in messages])

            assert len(queries) == 2, f"expected 2 queries, got {len(queries)}"
            assert queries[0].id != queries[1].id, "query ids must differ"
            assert queries[0].reply_subject != queries[1].reply_subject, (
                "reply_subjects must differ per §7.3"
            )

            response_chunks = [m for m in messages if isinstance(m, ResponseChunk)]
            assert len(response_chunks) == 1
            # gather() order is non-deterministic — accept either permutation.
            assert response_chunks[0].text in {
                "answer-a|answer-b",
                "answer-b|answer-a",
            }, f"unexpected composed answer: {response_chunks[0].text!r}"
        finally:
            await agents.close()
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_query_timeout(nc: NATSClient, evidence: EvidenceRecorder) -> None:
    """Caller never replies; agent catches QueryTimeout and continues."""

    async def _times_out(envelope: Envelope, stream: PromptStream) -> None:
        try:
            await stream.ask("anybody there?", timeout=0.3)
        except QueryTimeout as exc:
            await stream.send(f"timed out: {exc}")
            return
        await stream.send("unexpected-reply")

    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        name="stalls",
        nc=nc,
        description="timeout-tolerant agent",
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    service.on_prompt(_times_out)
    await service.start()

    try:
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)

            messages: list[ResponseChunk | Query | object] = []
            async for msg in agent.prompt("ping", timeout=5.0):
                messages.append(msg)
                # Deliberately do NOT reply — let the agent-side timeout fire.

            evidence.write_jsonl("chunks.jsonl", [_snapshot(m) for m in messages])

            queries = [m for m in messages if isinstance(m, Query)]
            responses = [m for m in messages if isinstance(m, ResponseChunk)]
            assert len(queries) == 1
            assert len(responses) == 1

            reply_subject = queries[0].reply_subject
            query_id = queries[0].id
            assert responses[0].text.startswith("timed out:"), (
                f"unexpected final chunk: {responses[0].text!r}"
            )
            assert reply_subject in responses[0].text or query_id in responses[0].text, (
                "timeout message should mention the reply_subject or query id for debuggability"
            )
        finally:
            await agents.close()
    finally:
        await service.stop()

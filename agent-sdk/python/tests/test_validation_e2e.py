"""End-to-end verification that §5.4 validation fires BEFORE any wire I/O.

Starts a real agent with restricted endpoint metadata
(``attachments_ok=false``, tiny ``max_payload``), discovers it via
:meth:`Agents.discover` (so the client picks up the capability metadata),
and asserts that :meth:`Agent.prompt` raises locally — without the agent
observing a request — when callers violate the declared limits.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from synadia_ai.agents import (
    Agents,
    Attachment,
    AttachmentsNotSupportedError,
    Envelope,
    PayloadTooLargeError,
    PromptEmptyError,
)

from synadia_ai.agent_service import AgentService, PromptStream

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


AGENT = "test"
OWNER = "pytest"
HEARTBEAT_INTERVAL_S = 30


async def _never_called(envelope: Envelope, stream: PromptStream) -> None:
    raise AssertionError("handler MUST NOT run — client-side validation should have fired")


@pytest.mark.asyncio
async def test_prompt_empty_raises_locally(nc: NATSClient) -> None:
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="strict-empty",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
    )
    service.on_prompt(_never_called)
    await service.start()

    try:
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)

            # prompt() is not a coroutine until awaited; validation happens at
            # the .prompt() call site (synchronous), not inside the async for.
            with pytest.raises(PromptEmptyError):
                agent.prompt("")
        finally:
            await agents.close()
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_attachments_rejected_when_not_supported(nc: NATSClient) -> None:
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="strict-noattach",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
        attachments_ok=False,
    )
    service.on_prompt(_never_called)
    await service.start()

    try:
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)
            assert agent.prompt_endpoint.attachments_ok is False

            with pytest.raises(AttachmentsNotSupportedError):
                agent.prompt(
                    "please process",
                    attachments=[Attachment.from_bytes("x.bin", b"\x00\x01\x02")],
                )
        finally:
            await agents.close()
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_payload_too_large_raises_with_context(nc: NATSClient) -> None:
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name="tiny-limit",
        nc=nc,
        heartbeat_interval_s=HEARTBEAT_INTERVAL_S,
        max_payload="1B",  # deliberately impossible: any non-empty envelope overflows
    )
    service.on_prompt(_never_called)
    await service.start()

    try:
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=1.0)
            agent = next(a for a in found if a.prompt_subject == service.subject.inbox)
            assert agent.prompt_endpoint.max_payload_bytes == 1

            with pytest.raises(PayloadTooLargeError) as excinfo:
                agent.prompt("this is longer than 1 byte")
            assert excinfo.value.limit == 1
            assert excinfo.value.actual > 1
        finally:
            await agents.close()
    finally:
        await service.stop()

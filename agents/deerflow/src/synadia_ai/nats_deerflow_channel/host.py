"""Protocol host wiring for the DeerFlow NATS channel."""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator, Callable
from contextlib import suppress
from typing import Any, cast

import nats
from nats.aio.client import Client as NATSClient
from synadia_ai.agent_service import AgentService, PromptHandler, PromptStream
from synadia_ai.agents import (
    Attachment,
    Envelope,
    ProtocolError,
    QueryTimeout,
    StatusChunk,
    load_context_options,
)

from .config import ChannelConfig
from .runner import ClarificationEvent, DeerFlowGatewayClient, TextEvent, ToolEvent

PromptRunner = Callable[[str], AsyncIterator[str]]
MAX_CLARIFICATION_ROUNDS = 8
MAX_ATTACHMENT_FILENAME_BYTES = 255
_SAFE_ATTACHMENT_BASENAME = re.compile(r"^[^/\\\x00]+$")


def _nats_connect_options(config: ChannelConfig) -> dict[str, object]:
    if config.nats_context:
        return dict(load_context_options(config.nats_context))
    if config.nats_url:
        return {"servers": config.nats_url}
    return dict(load_context_options("current"))


async def connect_nats(config: ChannelConfig) -> NATSClient:
    """Open a NATS connection for the channel wrapper."""
    return await nats.connect(**cast(dict[str, Any], _nats_connect_options(config)))


def build_agent_service(config: ChannelConfig, nc: NATSClient) -> AgentService:
    """Build the Synadia Agent Protocol service for DeerFlow."""
    if not config.owner:
        raise ValueError("owner is required to host the protocol service")
    service = AgentService(
        agent=config.agent,
        owner=config.owner,
        session_name=config.session,
        nc=nc,
        description="DeerFlow channel wrapper for the Synadia Agent Protocol",
        attachments_ok=True,
        max_payload=config.max_payload,
    )
    service.on_prompt(make_deerflow_prompt_handler(config))
    return service


def make_deerflow_prompt_handler(config: ChannelConfig) -> PromptHandler:
    """Build a prompt handler that bridges DeerFlow SSE to protocol chunks.

    DeerFlow surfaces human-in-the-loop clarification as an `ask_clarification`
    tool message in the thread stream. The Synadia Agent Protocol equivalent is
    a mid-stream query chunk, so the wrapper asks the caller and then posts the
    answer back to the same DeerFlow thread as the next user message.
    """

    async def _handler(envelope: Envelope, stream: PromptStream) -> None:
        _validate_attachment_filenames(envelope)
        client = DeerFlowGatewayClient(config, timeout=config.deerflow_timeout_s)
        try:
            prompt = envelope.prompt
            attachments = envelope.attachments
            for _ in range(MAX_CLARIFICATION_ROUNDS):
                reply = await _run_one_deerflow_turn(
                    client,
                    stream,
                    prompt,
                    attachments=attachments,
                    query_timeout_s=config.query_timeout_s,
                )
                if reply is None:
                    return
                _validate_attachment_filenames(reply)
                prompt = reply.prompt
                attachments = reply.attachments
            raise RuntimeError("too many DeerFlow clarification rounds")
        finally:
            await client.aclose()

    return _handler


async def _run_one_deerflow_turn(
    client: DeerFlowGatewayClient,
    stream: PromptStream,
    prompt: str,
    *,
    attachments: list[Attachment] | None,
    query_timeout_s: float,
) -> Envelope | None:
    async for event in client.stream_events(prompt, attachments=attachments):
        if isinstance(event, TextEvent):
            await stream.send(event.text)
            continue
        if isinstance(event, ToolEvent):
            await stream.send(StatusChunk(status=event.status))
            continue
        if isinstance(event, ClarificationEvent):
            try:
                return await stream.ask(event.prompt, timeout=query_timeout_s)
            except QueryTimeout as exc:
                raise TimeoutError(
                    f"caller did not answer DeerFlow clarification within {query_timeout_s:g}s"
                ) from exc
    return None


def _validate_attachment_filenames(envelope: Envelope) -> None:
    for attachment in envelope.attachments or []:
        filename = attachment.filename
        if (
            not filename
            or filename in {".", ".."}
            or not _SAFE_ATTACHMENT_BASENAME.match(filename)
            or len(filename.encode("utf-8")) > MAX_ATTACHMENT_FILENAME_BYTES
        ):
            raise ProtocolError(f"unsafe attachment filename: {filename!r}")


def make_prompt_handler(runner: PromptRunner) -> PromptHandler:
    """Adapt a prompt runner to the AgentService prompt-handler API."""

    async def _handler(envelope: Envelope, stream: PromptStream) -> None:
        async for chunk in runner(envelope.prompt):
            await stream.send(chunk)

    return _handler


async def run_channel(config: ChannelConfig, *, stop_event: asyncio.Event | None = None) -> None:
    """Run the long-lived protocol host until cancelled or stop_event is set."""
    nc = await connect_nats(config)
    service = build_agent_service(config, nc)
    await service.start()
    try:
        if stop_event is None:
            await asyncio.Event().wait()
        else:
            await stop_event.wait()
    finally:
        await service.stop()
        with suppress(Exception):
            await nc.close()

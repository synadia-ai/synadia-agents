"""Protocol host wiring for the DeerFlow NATS channel."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import suppress
from typing import Any, cast

import nats
from nats.aio.client import Client as NATSClient
from synadia_ai.agent_service import AgentService, PromptHandler, PromptStream
from synadia_ai.agents import Envelope, load_context_options

from .config import ChannelConfig
from .runner import fake_deerflow_runner

PromptRunner = Callable[[str], AsyncIterator[str]]


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
        attachments_ok=False,
    )
    service.on_prompt(make_prompt_handler(fake_deerflow_runner))
    return service


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

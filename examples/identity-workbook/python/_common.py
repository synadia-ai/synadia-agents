"""Shared, intentionally small plumbing for the Python identity workbook."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import nats
from synadia_ai.agents import (
    Agent,
    Agents,
    DiscoverFilter,
    NatsConnectionBundle,
    NkeySigner,
    ResponseChunk,
    SenderInfo,
    StreamMessage,
    format_sender,
    resolve_nats_connection_bundle,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

WORKBOOK_DIR = Path(__file__).resolve().parent
DEFAULT_NATS_URL = "nats://127.0.0.1:4222"
OWNER = "identity-workbook"
SESSION_NAME = "main"


@dataclass(slots=True)
class ConnectedUser:
    """One NKEY-authenticated connection and the matching request signer."""

    nc: NATSClient
    bundle: NatsConnectionBundle[NkeySigner]

    @property
    def signer(self) -> NkeySigner:
        """Return the signer derived from the connection credential snapshot."""
        return self.bundle.signer

    async def close(self) -> None:
        """Close the connection, then erase retained authentication material."""
        await self.nc.close()
        self.bundle.wipe()


def default_seed_path(role: str) -> Path:
    return WORKBOOK_DIR / ".local" / f"{role}.nkey"


async def connect_user(url: str, seed_path: Path) -> ConnectedUser:
    """Connect with one SDK-owned authentication and identity snapshot.

    The workbook never reads or parses the seed. The connection-bundle helper
    owns credential loading, the NATS authenticator, signer derivation, and
    cleanup, so the service/caller signer cannot drift from the connection.
    """
    bundle = resolve_nats_connection_bundle(
        url=url,
        nkey=seed_path.expanduser(),
        identity="signed",
    )
    try:
        nc = await nats.connect(**bundle.connection_options)
    except Exception:
        bundle.wipe()
        raise
    return ConnectedUser(nc=nc, bundle=bundle)


def describe_sender(sender: SenderInfo | None) -> str:
    """Describe achieved trust without exposing signature material."""
    return "(unknown sender)" if sender is None else format_sender(sender)


async def discover_verified_agent(agents: Agents, agent_name: str) -> Agent:
    """Discover one agent instance and verify its signed registration."""
    found = await agents.discover(
        timeout=1.0,
        filter=DiscoverFilter(agent=agent_name, owner=OWNER, session_name=SESSION_NAME),
    )
    if len(found) != 1:
        raise RuntimeError(f"expected one {agent_name} agent, discovered {len(found)}")
    agent = found[0]
    if agent.identity is None:
        raise RuntimeError(f"{agent_name} did not register an identity")
    if not agent.id_sig_verified:
        raise RuntimeError(f"{agent_name}'s registration identity signature did not verify")
    if not agent.supports_sender_identity or agent.min_sender_trust != "any":
        raise RuntimeError(f"{agent_name} does not advertise min_sender_trust=any")
    return agent


async def discover_verified_echo(agents: Agents) -> Agent:
    """Discover exactly one Echo instance and verify its signed registration."""
    return await discover_verified_agent(agents, "echo")


async def response_text(stream: AsyncIterator[StreamMessage]) -> str:
    """Collect the response text chunks from one prompt stream."""
    parts: list[str] = []
    async for message in stream:
        if isinstance(message, ResponseChunk):
            parts.append(message.text)
    return "".join(parts)

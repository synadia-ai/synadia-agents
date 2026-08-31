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
    NkeySigner,
    ResponseChunk,
    StreamMessage,
    signer_from_seed,
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
    signer: NkeySigner

    async def close(self) -> None:
        """Close the connection, then erase the signer's in-memory key material."""
        try:
            await self.nc.close()
        finally:
            self.signer.wipe()


def default_seed_path(role: str) -> Path:
    return WORKBOOK_DIR / ".local" / f"{role}.nkey"


async def connect_user(url: str, seed_path: Path) -> ConnectedUser:
    """Connect with a seed file and return a signer derived from that same seed.

    The seed is never logged. ``signer_from_seed`` also guarantees that its
    validation errors do not include the supplied key material.
    """
    seed = seed_path.expanduser().read_bytes()
    signer = signer_from_seed(seed)
    seed_line = seed.decode("ascii").strip()
    try:
        nc = await nats.connect(servers=url, nkeys_seed_str=seed_line)
    except Exception:
        signer.wipe()
        raise
    return ConnectedUser(nc=nc, signer=signer)


async def discover_verified_echo(agents: Agents) -> Agent:
    """Discover exactly one Echo instance and verify its signed registration."""
    found = await agents.discover(
        timeout=1.0,
        filter=DiscoverFilter(agent="echo", owner=OWNER, session_name=SESSION_NAME),
    )
    if len(found) != 1:
        raise RuntimeError(f"expected one Echo agent, discovered {len(found)}")
    echo = found[0]
    if echo.identity is None:
        raise RuntimeError("Echo did not register an identity")
    if not echo.id_sig_verified:
        raise RuntimeError("Echo's registration identity signature did not verify")
    if not echo.supports_sender_identity or echo.min_sender_trust != "signed":
        raise RuntimeError("Echo does not advertise min_sender_trust=signed")
    return echo


async def response_text(stream: AsyncIterator[StreamMessage]) -> str:
    """Collect the response text chunks from one prompt stream."""
    parts: list[str] = []
    async for message in stream:
        if isinstance(message, ResponseChunk):
            parts.append(message.text)
    return "".join(parts)

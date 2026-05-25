"""Prompt runners for the DeerFlow channel."""

from __future__ import annotations

from collections.abc import AsyncIterator


async def fake_deerflow_runner(prompt: str) -> AsyncIterator[str]:
    """Yield deterministic chunks for Phase 2 protocol-host tests.

    The real DeerFlow Gateway bridge replaces this in Phase 3. Keeping this
    separate lets us prove protocol hosting without depending on a running
    DeerFlow instance.
    """
    yield "DeerFlow fake runner received: "
    yield prompt

from __future__ import annotations

from collections.abc import AsyncIterator


async def fake_deerflow_runner(prompt: str) -> AsyncIterator[str]:
    """Yield deterministic chunks for protocol-host tests."""
    yield "DeerFlow fake runner received: "
    yield prompt

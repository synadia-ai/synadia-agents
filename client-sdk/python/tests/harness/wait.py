"""Deterministic waits for the identity e2e tests.

``nc.flush()`` proves the server processed what the client sent, but a
subscription *callback* runs on that subscription's own dispatch task, so
a list a callback appends to can still be empty right after the flush.
Poll a condition with a deadline instead of sleeping (CLAUDE.md: no
``sleep()`` band-aids).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable

DEFAULT_TIMEOUT_S = 2.0
POLL_INTERVAL_S = 0.01


async def wait_for(
    condition: Callable[[], bool], *, timeout_s: float = DEFAULT_TIMEOUT_S, what: str = "condition"
) -> None:
    """Return once ``condition()`` is true; raise :class:`AssertionError` after ``timeout_s``."""
    deadline = time.monotonic() + timeout_s
    while not condition():
        if time.monotonic() >= deadline:
            raise AssertionError(f"{what} not met within {timeout_s:g}s")
        await asyncio.sleep(POLL_INTERVAL_S)

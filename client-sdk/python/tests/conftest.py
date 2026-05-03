"""Pytest fixtures for the synadia-ai-agents test suite."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from typing import TYPE_CHECKING

import nats
import pytest
import pytest_asyncio

from tests.harness.evidence import EvidenceRecorder
from tests.harness.nats_server import RunningServer, find_nats_server, start_server

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


EVIDENCE_ROOT = Path(__file__).parent / "_evidence"


@pytest.fixture(scope="session")
def nats_server() -> Iterator[RunningServer]:
    """Spawn a real nats-server for the session. Skips if the binary is absent."""
    if find_nats_server() is None:
        pytest.skip(
            "nats-server not on PATH — integration tests skipped. "
            "Install with `brew install nats-server` (macOS) or see "
            "https://docs.nats.io/running-a-nats-service/introduction/installation"
        )
    log_dir = EVIDENCE_ROOT / "_nats-server-logs"
    server = start_server(log_dir)
    try:
        yield server
    finally:
        server.stop()


@pytest_asyncio.fixture
async def nc(nats_server: RunningServer) -> AsyncIterator[NATSClient]:
    """A connected NATS client, closed on teardown."""
    client = await nats.connect(nats_server.url)
    try:
        yield client
    finally:
        await client.close()


@pytest_asyncio.fixture
async def bg_tasks() -> AsyncIterator[Callable[[asyncio.Task[object]], None]]:
    """Track background tasks (e.g. fake-agent emit loops) and cancel at teardown.

    Tests that spawn a forever-loop in a NATS subscription callback —
    typically ``while True: await nc.publish(...); await asyncio.sleep(...)``
    — must register the task here. Otherwise pytest-asyncio prints
    ``Task was destroyed but it is pending`` warnings and the dying
    task can log noise into a later test's evidence directory when
    :meth:`Client.close` causes it to crash with
    :class:`~nats.errors.ConnectionClosedError`.

    Use::

        async def fake_agent(msg: Msg) -> None:
            t = asyncio.create_task(emit_loop(msg))
            bg_tasks(t)
    """
    tasks: set[asyncio.Task[object]] = set()

    def register(task: asyncio.Task[object]) -> None:
        tasks.add(task)

    try:
        yield register
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            with contextlib.suppress(BaseException):
                await asyncio.gather(*tasks, return_exceptions=True)


@pytest_asyncio.fixture
async def evidence(
    request: pytest.FixtureRequest, nc: NATSClient
) -> AsyncIterator[EvidenceRecorder]:
    """Per-test evidence recorder attached to the NATS connection.

    The recorder's wildcard spy is attached BEFORE the test body runs so
    nothing published during the test is missed, and detached on teardown
    so later tests don't pollute each other's `messages.jsonl`.
    """
    recorder = EvidenceRecorder.for_test(EVIDENCE_ROOT, request.node.nodeid)
    await recorder.attach(nc)
    try:
        yield recorder
    finally:
        await recorder.detach()

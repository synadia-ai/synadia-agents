"""Pytest fixtures for the synadia-ai-agents test suite."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
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

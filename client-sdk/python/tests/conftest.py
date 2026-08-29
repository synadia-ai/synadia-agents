"""Pytest fixtures for the synadia-ai-agents test suite."""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

import nats
import pytest
import pytest_asyncio

from tests.harness.evidence import EvidenceRecorder
from tests.harness.nats_server import (
    RunningServer,
    find_nats_server,
    identity_fixture,
    start_server,
)

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


class EvidenceFor(Protocol):
    """``await evidence_for(nc)`` → a recorder spying on *that* connection."""

    def __call__(self, nc: NATSClient, /) -> Awaitable[EvidenceRecorder]: ...


@pytest_asyncio.fixture
async def evidence_for(request: pytest.FixtureRequest) -> AsyncIterator[EvidenceFor]:
    """Evidence recorder factory for the identity servers' *authenticated* connections.

    The ``evidence`` fixture is bound to the session server's anonymous
    ``nc``; identity tests connect as nkey users to per-topology servers,
    so they attach the spy to their own connection instead. The
    ``_INBOX.>`` spy captures the ``$SYS.REQ.USER.INFO`` reply and every
    ``Agent-Sender``-bearing request's reply stream; ``agents.>`` /
    ``$SRV.>`` capture the requests themselves, headers included. Every
    recorder is detached on teardown.
    """
    attached: list[EvidenceRecorder] = []

    async def _attach(nc: NATSClient, /) -> EvidenceRecorder:
        recorder = EvidenceRecorder.for_test(EVIDENCE_ROOT, request.node.nodeid)
        await recorder.attach(nc)
        attached.append(recorder)
        return recorder

    try:
        yield _attach
    finally:
        for recorder in attached:
            with contextlib.suppress(Exception):
                await recorder.detach()


# --- sender-identity test infrastructure -----------------------------------
#
# Per-topology nats-server fixtures over the repo-level configs in
# ``test-fixtures/identity/`` (session-scoped, started lazily on first use),
# the throwaway users from ``keys.json``, and nkey-authenticated connections.
# ``nc_alice`` … ``nc_erin`` are bound to ``accounts.conf`` — the only
# topology where all five users exist; use ``connect_nkey_user`` for the
# single-user servers.


@dataclass(frozen=True, slots=True)
class NkeyUser:
    """One throwaway user from ``test-fixtures/identity/keys.json``."""

    name: str
    public: str
    seed: str


@dataclass(slots=True)
class DenySysClient:
    """alice on ``nkey-deny-sys.conf`` plus every error nats-py reported for her.

    The server answers a publish to ``$SYS.>`` with an asynchronous
    ``-ERR 'Permissions Violation …'`` — no reply, no disconnect. nats-py
    hands it to ``error_cb`` (recorded in :attr:`errors`) and keeps it as
    ``Client.last_error``.
    """

    nc: NATSClient
    errors: list[Exception] = field(default_factory=list)


class ConnectNkeyUser(Protocol):
    """``await connect_nkey_user(server, "alice", **nats_connect_kwargs)``."""

    def __call__(
        self, server: RunningServer, name: str, /, **kwargs: Any
    ) -> Awaitable[NATSClient]: ...


@pytest.fixture(scope="session")
def identity_keys() -> dict[str, NkeyUser]:
    """The throwaway users in ``keys.json``, by name."""
    raw = json.loads(identity_fixture("keys.json").read_text(encoding="utf-8"))
    return {
        name: NkeyUser(name=name, public=user["public"], seed=user["seed"])
        for name, user in raw["users"].items()
    }


def _fixture_server(config: str | None, *, jetstream: bool = False) -> Iterator[RunningServer]:
    if find_nats_server() is None:
        pytest.skip("nats-server not on PATH — identity fixture servers skipped")
    log_dir = EVIDENCE_ROOT / "_nats-server-logs"
    config_path = identity_fixture(config) if config is not None else None
    server = start_server(log_dir, config_path=config_path, jetstream=jetstream)
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture(scope="session")
def nats_server_nkey() -> Iterator[RunningServer]:
    """``nkey-noaccounts.conf``: alice as an nkey user in the global account ``$G``."""
    yield from _fixture_server("nkey-noaccounts.conf")


@pytest.fixture(scope="session")
def nats_server_nkey_deny_sys() -> Iterator[RunningServer]:
    """``nkey-deny-sys.conf``: alice, with publishes to ``$SYS.>`` denied."""
    yield from _fixture_server("nkey-deny-sys.conf")


@pytest.fixture(scope="session")
def nats_server_accounts() -> Iterator[RunningServer]:
    """``accounts.conf``: ACME (alice, carol) / APP (bob) / APP2 (dave) / APP3 (erin)."""
    yield from _fixture_server("accounts.conf")


@pytest.fixture(scope="session")
def nats_server_atp() -> Iterator[RunningServer]:
    """``account-token-position.conf``: ACME exports ``svc.*.prompt`` with the token inserted."""
    yield from _fixture_server("account-token-position.conf")


@pytest.fixture(scope="session")
def nats_server_js() -> Iterator[RunningServer]:
    """No auth, JetStream enabled on a throwaway store dir (``-js -sd``)."""
    yield from _fixture_server(None, jetstream=True)


@pytest_asyncio.fixture
async def connect_nkey_user(identity_keys: dict[str, NkeyUser]) -> AsyncIterator[ConnectNkeyUser]:
    """Factory: connect to *server* as a ``keys.json`` user via ``nkeys_seed_str``.

    Every connection it opens is closed on teardown.
    """
    opened: list[NATSClient] = []

    async def _connect(server: RunningServer, name: str, /, **kwargs: Any) -> NATSClient:
        nc = await nats.connect(server.url, nkeys_seed_str=identity_keys[name].seed, **kwargs)
        opened.append(nc)
        return nc

    try:
        yield _connect
    finally:
        for nc in opened:
            if not nc.is_closed:
                await nc.close()


@pytest_asyncio.fixture
async def nc_alice(
    nats_server_accounts: RunningServer, connect_nkey_user: ConnectNkeyUser
) -> NATSClient:
    """alice — account ACME on ``accounts.conf``."""
    return await connect_nkey_user(nats_server_accounts, "alice")


@pytest_asyncio.fixture
async def nc_bob(
    nats_server_accounts: RunningServer, connect_nkey_user: ConnectNkeyUser
) -> NATSClient:
    """bob — account APP (``share: true`` imports) on ``accounts.conf``."""
    return await connect_nkey_user(nats_server_accounts, "bob")


@pytest_asyncio.fixture
async def nc_carol(
    nats_server_accounts: RunningServer, connect_nkey_user: ConnectNkeyUser
) -> NATSClient:
    """carol — account ACME (alice's same-account peer) on ``accounts.conf``."""
    return await connect_nkey_user(nats_server_accounts, "carol")


@pytest_asyncio.fixture
async def nc_dave(
    nats_server_accounts: RunningServer, connect_nkey_user: ConnectNkeyUser
) -> NATSClient:
    """dave — account APP2 (imports without ``share``) on ``accounts.conf``."""
    return await connect_nkey_user(nats_server_accounts, "dave")


@pytest_asyncio.fixture
async def nc_erin(
    nats_server_accounts: RunningServer, connect_nkey_user: ConnectNkeyUser
) -> NATSClient:
    """erin — account APP3 (rename-only ``to: local.agents.>`` import) on ``accounts.conf``."""
    return await connect_nkey_user(nats_server_accounts, "erin")


@pytest_asyncio.fixture
async def nc_alice_deny_sys(
    nats_server_nkey_deny_sys: RunningServer, connect_nkey_user: ConnectNkeyUser
) -> DenySysClient:
    """alice on ``nkey-deny-sys.conf`` with an ``error_cb`` that records violations."""
    errors: list[Exception] = []

    async def _record(exc: Exception) -> None:
        errors.append(exc)

    nc = await connect_nkey_user(nats_server_nkey_deny_sys, "alice", error_cb=_record)
    return DenySysClient(nc=nc, errors=errors)

"""Tracing interoperates with peers that have none — across languages and versions.

A traced caller must be served by a host that never opted in (which
adopts its lineage) and by a host that predates the extension entirely
(which ignores the two envelope fields, §5.6). An untraced caller must be
served by a traced host, which mints a root of its own, and must see
nothing of tracing on the wire. The counterparty here is a TypeScript
``AgentService`` run by ``bun`` from ``test-fixtures/interop``; the
TypeScript SDK runs the mirror image against a Python host.

The cross-version case needs the last published, pre-tracing
``@synadia-ai/agent-service`` installed somewhere::

    mkdir old-ts && cd old-ts && echo '{"type":"module"}' > package.json
    bun add @synadia-ai/agent-service@0.5.2 @synadia-ai/agents@0.5.2 @nats-io/transport-node
    export SYNADIA_INTEROP_PRETRACING_TS_DIR=$PWD

and skips when that variable is unset. Everything else skips only when
``bun`` or the TS SDK's dependencies are missing, like
:mod:`tests.test_interop_e2e`.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from synadia_ai.agents import (
    Agents,
    Identity,
    ResponseChunk,
    TraceOptions,
    is_thread_id,
    parse_sender_header,
    read_sender_header_value,
    signer_from_seed,
)
from tests.test_interop_e2e import TSSDK_DIR, _interop_prereqs_missing

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser, NkeyUser
    from tests.harness.nats_server import RunningServer

HOST_SCRIPT = (
    Path(__file__).resolve().parents[3] / "test-fixtures" / "interop" / "ts-agent-service-host.ts"
)
READY_MARKER = "agent service listening on "
STARTUP_TIMEOUT_S = 20.0
PRETRACING_TS_DIR_ENV = "SYNADIA_INTEROP_PRETRACING_TS_DIR"
_ECHO = re.compile(
    r"^echo: (?P<prompt>.*?)(?: thread=(?P<thread>[0-9a-f]{32}) root=(?P<root>[0-9a-f]{32}))?$"
)

pytestmark = pytest.mark.skipif(_interop_prereqs_missing() is not None, reason="TS SDK unavailable")


class _TsHost:
    """A TypeScript ``AgentService`` in a ``bun`` subprocess."""

    def __init__(
        self,
        nats_url: str,
        *,
        agent: str,
        cwd: Path = TSSDK_DIR,
        traced: bool = False,
        seed_file: Path | None = None,
    ) -> None:
        self._env = {
            **os.environ,
            "NATS_URL": nats_url,
            "AGENT": agent,
            "TRACE": "1" if traced else "0",
            **({"NATS_NKEY_SEED_FILE": str(seed_file)} if seed_file else {}),
        }
        self._cwd = cwd
        self._proc: subprocess.Popen[str] | None = None
        self.prompt_subject: str = ""
        self.stdout_tail: list[str] = []

    async def start(self) -> None:
        self._proc = subprocess.Popen(
            ["bun", "run", "-"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(self._cwd),
            env=self._env,
            text=True,
            bufsize=1,
        )
        assert self._proc.stdin is not None and self._proc.stdout is not None
        self._proc.stdin.write(HOST_SCRIPT.read_text(encoding="utf-8"))
        self._proc.stdin.close()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + STARTUP_TIMEOUT_S
        while loop.time() < deadline:
            line = await loop.run_in_executor(None, self._proc.stdout.readline)
            if not line:
                raise RuntimeError(
                    f"TS host exited before ready (code={self._proc.poll()}); "
                    f"tail:\n{''.join(self.stdout_tail[-20:])}"
                )
            self.stdout_tail.append(line)
            if READY_MARKER in line:
                self.prompt_subject = line.split(READY_MARKER, 1)[1].strip()
                return
        raise TimeoutError(
            f"TS host not ready in {STARTUP_TIMEOUT_S}s:\n{''.join(self.stdout_tail)}"
        )

    async def stop(self) -> None:
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            await asyncio.get_running_loop().run_in_executor(None, lambda: proc.wait(timeout=5))
        except subprocess.TimeoutExpired:
            proc.kill()


async def _host(
    nats_url: str, **kwargs: Any
) -> AsyncIterator[_TsHost]:  # pragma: no cover — trivial
    host = _TsHost(nats_url, **kwargs)
    await host.start()
    try:
        yield host
    finally:
        await host.stop()


async def _echo(agents: Agents, subject: str, text: str) -> tuple[str, str | None, str | None]:
    """Prompt the host at ``subject``; return the echoed prompt and lineage."""
    found = await agents.discover(timeout=3.0)
    handle = next(a for a in found if a.prompt_subject == subject)
    texts = [
        c.text async for c in handle.prompt(text, timeout=10.0) if isinstance(c, ResponseChunk)
    ]
    assert len(texts) == 1, texts
    m = _ECHO.match(texts[0])
    assert m is not None, texts[0]
    return m.group("prompt"), m.group("thread"), m.group("root")


async def _capture(nc: NATSClient, subject: str) -> list[Msg]:
    seen: list[Msg] = []

    async def cb(msg: Msg) -> None:
        seen.append(msg)

    await nc.subscribe(subject, cb=cb)
    await nc.flush()
    return seen


async def test_traced_python_caller_is_adopted_by_an_untraced_ts_host(
    nats_server: RunningServer, nc: NATSClient
) -> None:
    async for host in _host(nats_server.url, agent="ts-untraced"):
        prompts = await _capture(nc, host.prompt_subject)
        agents = Agents(nc=nc, trace=TraceOptions(edge_subject=None))
        try:
            prompt, thread, root = await _echo(agents, host.prompt_subject, "hi")
        finally:
            await agents.close()
        assert prompt == "hi"
        sent = json.loads(prompts[0].data)
        assert is_thread_id(sent["thread_id"]) and sent["root_id"] == sent["thread_id"]
        # The untraced host adopted the caller's lineage rather than
        # dropping it or minting its own.
        assert thread == sent["thread_id"]
        assert root == sent["root_id"]


async def test_untraced_python_caller_is_served_by_a_traced_ts_host(
    nats_server: RunningServer, nc: NATSClient
) -> None:
    async for host in _host(nats_server.url, agent="ts-traced", traced=True):
        prompts = await _capture(nc, host.prompt_subject)
        traces = await _capture(nc, "TRACE.>")
        agents = Agents(nc=nc)  # never traced
        try:
            prompt, thread, root = await _echo(agents, host.prompt_subject, "hi")
        finally:
            await agents.close()
        assert prompt == "hi"
        # Plain protocol 0.3 on the wire …
        assert prompts[0].data == b'{"prompt":"hi"}'
        # … and the host minted a root of its own for the execution.
        assert thread is not None and root == thread
        await asyncio.sleep(0.2)
        assert traces == [], "a host writes no trace record"


async def test_traced_python_caller_publishes_edges_while_talking_to_an_untraced_ts_host(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    tmp_path: Path,
) -> None:
    alice = identity_keys["alice"]
    seed_file = tmp_path / "alice.nk"
    seed_file.write_text(alice.seed + "\n", encoding="utf-8")
    seed_file.chmod(0o600)
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    async for host in _host(nats_server_nkey.url, agent="ts-untraced-nk", seed_file=seed_file):
        edges = await _capture(nc, "TRACE.edges")
        agents = Agents(
            nc=nc, identity=Identity(signer=signer_from_seed(alice.seed)), trace=TraceOptions()
        )
        try:
            prompt, thread, _root = await _echo(agents, host.prompt_subject, "hi")
        finally:
            await agents.close()
        assert prompt == "hi"
        await asyncio.sleep(0.2)
        assert len(edges) == 1, [e.data for e in edges]
        record = json.loads(edges[0].data)
        assert record["thread_id"] == thread, "the edge names the thread the host adopted"
        assert record["parent_id"] is None
        assert "Agent-Sender" in (edges[0].headers or {}), "edge records are signed"
        sender = parse_sender_header(read_sender_header_value(edges[0].headers) or "")
        assert sender is not None
        # The body names the same writer the signed header attests.
        assert record["agent"] == f"{sender.account}.{sender.user}"
        assert sender.user == alice.public
        # One id three ways: the body's record_id is the signed nonce and the Nats-Msg-Id.
        assert sender.nonce == record["record_id"]
        assert (edges[0].headers or {})["Nats-Msg-Id"] == record["record_id"]


@pytest.mark.skipif(
    PRETRACING_TS_DIR_ENV not in os.environ, reason=f"{PRETRACING_TS_DIR_ENV} unset"
)
async def test_traced_python_caller_against_the_last_published_ts_host(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    tmp_path: Path,
) -> None:
    """A host that predates tracing sees two unknown envelope fields and
    nothing else; it must serve the prompt as if they were not there."""
    old_dir = Path(os.environ[PRETRACING_TS_DIR_ENV])
    alice = identity_keys["alice"]
    seed_file = tmp_path / "alice.nk"
    seed_file.write_text(alice.seed + "\n", encoding="utf-8")
    seed_file.chmod(0o600)
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    async for host in _host(nats_server_nkey.url, agent="ts-old", cwd=old_dir, seed_file=seed_file):
        edges = await _capture(nc, "TRACE.edges")
        agents = Agents(
            nc=nc, identity=Identity(signer=signer_from_seed(alice.seed)), trace=TraceOptions()
        )
        try:
            prompt, thread, _root = await _echo(agents, host.prompt_subject, "hello old host")
        finally:
            await agents.close()
        assert prompt == "hello old host"
        assert thread is None, "a pre-tracing host has no lineage to echo"
        await asyncio.sleep(0.2)
        assert len(edges) == 1, "the caller still records the edge"

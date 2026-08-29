"""Reverse cross-SDK interop — the TypeScript caller against the Python host.

The forward leg (``client-sdk/python/tests/test_interop_e2e.py``) runs the
TS reference *agent* and prompts it from Python. This is the other
direction: an in-process :class:`AgentService` serves an echo agent on the
session's nats-server, and the TS SDK's one-shot probe
(``client-sdk/typescript/examples/_run-client-probe.ts``) discovers and
prompts it via ``bun``. The probe writes NDJSON — one line per decoded
chunk, then ``{"type":"done","chunks":N}`` — and exits 0 iff the §6.5
terminator arrived, so every assertion here is on bytes a *different*
implementation decoded.

Skips (never fails) when ``bun`` is not on PATH, the TS sibling is
missing, or its ``node_modules/`` is not populated (``bun install`` in
``client-sdk/typescript``).
"""

from __future__ import annotations

import asyncio
import functools
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
import pytest_asyncio
from synadia_ai.agents import Envelope

from synadia_ai.agent_service import AgentService, PromptStream
from tests.harness.evidence import EvidenceRecorder

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient

    from tests.harness.nats_server import RunningServer

# Monorepo root: tests/ → agent-sdk/python/ → agent-sdk/ → root.
REPO_ROOT = Path(__file__).resolve().parents[3]
TSSDK_DIR = REPO_ROOT / "client-sdk" / "typescript"
CLIENT_PROBE_SCRIPT = TSSDK_DIR / "examples" / "_run-client-probe.ts"
EVIDENCE_ROOT = Path(__file__).parent / "_evidence"

PROBE_TIMEOUT_S = 10.0
PROBE_GRACE_S = 20.0  # bun cold start + connect, on top of --timeout-s
PROBE_EXIT_NO_AGENT = 2

AGENT = "test"  # NOT 'pysdk' — CLAUDE.md forbids the SDK owning an agent id.
OWNER = "pytest-reverse"  # unique per file so the probe's filter cannot match another test's agent
SESSION_NAME = "reverse-interop"


def _interop_prereqs_missing() -> str | None:
    """Return a skip-reason if any prereq is missing, else None."""
    if shutil.which("bun") is None:
        return "bun not on PATH — skipping reverse cross-SDK interop test"
    if not TSSDK_DIR.is_dir():
        return f"TS SDK sibling not found at {TSSDK_DIR} — unexpected in a fresh monorepo checkout"
    if not CLIENT_PROBE_SCRIPT.is_file():
        return f"client probe script missing at {CLIENT_PROBE_SCRIPT}"
    if not (TSSDK_DIR / "node_modules").is_dir():
        return (
            "TS SDK dependencies not installed — "
            f"run `bun install` in {TSSDK_DIR} to enable interop tests"
        )
    return None


@dataclass(frozen=True, slots=True)
class ProbeResult:
    """One probe run: exit status, parsed NDJSON lines, stderr."""

    returncode: int
    lines: list[dict[str, Any]]
    stderr: str

    @property
    def done(self) -> dict[str, Any] | None:
        return next((line for line in self.lines if line.get("type") == "done"), None)

    @property
    def chunks(self) -> list[dict[str, Any]]:
        return [line for line in self.lines if line.get("type") != "done"]


class _TsClientProcess:
    """Run the TS probe once against a NATS URL and parse its NDJSON.

    One-shot: ``subprocess.run(..., timeout=)`` — there is no ready marker
    to wait for. It runs in a worker thread because the :class:`AgentService`
    under test serves the prompt on this very event loop.
    """

    def __init__(self, nats_url: str) -> None:
        self._nats_url = nats_url

    async def prompt(
        self, *, agent: str, owner: str, prompt: str, timeout_s: float = PROBE_TIMEOUT_S
    ) -> ProbeResult:
        cmd = [
            "bun",
            "run",
            str(CLIENT_PROBE_SCRIPT),
            "--agent",
            agent,
            "--owner",
            owner,
            "--prompt",
            prompt,
            "--timeout-s",
            str(timeout_s),
        ]
        env = {**os.environ, "NATS_URL": self._nats_url}
        run = functools.partial(
            subprocess.run,
            cmd,
            cwd=str(TSSDK_DIR),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_s + PROBE_GRACE_S,
            check=False,
        )
        completed: subprocess.CompletedProcess[
            str
        ] = await asyncio.get_running_loop().run_in_executor(None, run)
        lines = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
        return ProbeResult(returncode=completed.returncode, lines=lines, stderr=completed.stderr)


async def _echo(envelope: Envelope, stream: PromptStream) -> None:
    await stream.send(envelope.prompt)


@pytest.fixture
def ts_client_probe(nats_server: RunningServer) -> _TsClientProcess:
    reason = _interop_prereqs_missing()
    if reason is not None:
        pytest.skip(reason)
    return _TsClientProcess(nats_server.url)


@pytest_asyncio.fixture
async def echo_service(nc: NATSClient) -> AsyncIterator[AgentService]:
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name=SESSION_NAME,
        nc=nc,
        description="reverse-interop echo agent",
    )
    service.on_prompt(_echo)
    await service.start()
    try:
        yield service
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_ts_probe_discovers_and_prompts_the_python_agent(
    echo_service: AgentService,
    ts_client_probe: _TsClientProcess,
    request: pytest.FixtureRequest,
) -> None:
    """TS client → Python host: discovery by filter, one prompt, terminator seen."""
    result = await ts_client_probe.prompt(agent=AGENT, owner=OWNER, prompt="hello from bun")
    EvidenceRecorder.for_test(EVIDENCE_ROOT, request.node.nodeid).write_json(
        "probe.json",
        {
            "prompt_subject": echo_service.subject.prompt,
            "returncode": result.returncode,
            "lines": result.lines,
            "stderr": result.stderr,
        },
    )

    assert result.returncode == 0, (
        f"probe failed (code={result.returncode}); stderr:\n{result.stderr}"
    )
    assert result.done is not None, f"no done line; lines: {result.lines!r}"
    assert result.lines[-1] == result.done
    assert result.done["chunks"] == len(result.chunks)

    # §6.4: the host emits a leading `status=ack` before the handler's first chunk.
    assert result.chunks[0]["type"] == "status"
    assert result.chunks[0]["status"] == "ack"
    responses = [chunk for chunk in result.chunks if chunk["type"] == "response"]
    assert [chunk["text"] for chunk in responses] == ["hello from bun"]


@pytest.mark.asyncio
async def test_ts_probe_exits_2_when_no_agent_matches(
    ts_client_probe: _TsClientProcess,
) -> None:
    """The probe's exit contract: no `done` line and status 2 without a match."""
    result = await ts_client_probe.prompt(
        agent="nobody", owner="nowhere", prompt="unanswered", timeout_s=2.0
    )
    assert result.returncode == PROBE_EXIT_NO_AGENT, result.stderr
    assert result.done is None
    assert "no agent matched" in result.stderr

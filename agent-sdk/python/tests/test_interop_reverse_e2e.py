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

The sender-identity leg runs the same probe with ``--signed`` and
``NATS_NKEY_SEED_FILE`` (a file, never an env value holding the seed)
against a Python ``AgentService`` requiring ``min_sender_trust: signed``
on ``nkey-noaccounts.conf``: the TS caller signs, the Python host
verifies and echoes the formatted sender; an unsigned probe is refused
before it publishes. Without ``--signed`` the probe sends **no**
``Agent-Sender`` at all, so the two modes are exactly "verified" and
"absent" at the receiver.

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
from synadia_ai.agents import AgentId, Envelope, format_sender, signer_from_seed

from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from tests.harness.evidence import EvidenceRecorder

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient
    from synadia_ai.agents import SenderInfo

    from tests.conftest import ConnectNkeyUser, NkeyUser
    from tests.harness.nats_server import RunningServer

# Monorepo root: tests/ → agent-sdk/python/ → agent-sdk/ → root.
REPO_ROOT = Path(__file__).resolve().parents[3]
TSSDK_DIR = REPO_ROOT / "client-sdk" / "typescript"
CLIENT_PROBE_SCRIPT = TSSDK_DIR / "examples" / "_run-client-probe.ts"
EVIDENCE_ROOT = Path(__file__).parent / "_evidence"

PROBE_TIMEOUT_S = 10.0
PROBE_GRACE_S = 20.0  # bun cold start + connect, on top of --timeout-s
PROBE_EXIT_NO_AGENT = 2
PROBE_EXIT_ERROR = 1

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
    def identity(self) -> str | None:
        """The ``--signed`` probe's own agent ID (its first line), else ``None``."""
        line = next((line for line in self.lines if line.get("type") == "identity"), None)
        return None if line is None else str(line["id"])

    @property
    def chunks(self) -> list[dict[str, Any]]:
        return [line for line in self.lines if line.get("type") not in ("done", "identity")]

    @property
    def error(self) -> dict[str, Any] | None:
        """The ``{"type":"error",…}`` line on stderr, if any."""
        for raw in self.stderr.splitlines():
            if raw.startswith("{"):
                parsed: dict[str, Any] = json.loads(raw)
                if parsed.get("type") == "error":
                    return parsed
        return None


class _TsClientProcess:
    """Run the TS probe once against a NATS URL and parse its NDJSON.

    One-shot: ``subprocess.run(..., timeout=)`` — there is no ready marker
    to wait for. It runs in a worker thread because the :class:`AgentService`
    under test serves the prompt on this very event loop.
    """

    def __init__(self, nats_url: str, *, seed_file: Path | None = None) -> None:
        self._nats_url = nats_url
        self._seed_file = seed_file

    async def prompt(
        self,
        *,
        agent: str,
        owner: str,
        prompt: str,
        timeout_s: float = PROBE_TIMEOUT_S,
        signed: bool = False,
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
        if signed:
            cmd.append("--signed")
        env = {**os.environ, "NATS_URL": self._nats_url}
        env.pop("NATS_NKEY_SEED_FILE", None)
        env.pop("NATS_CREDS", None)
        if self._seed_file is not None:
            env["NATS_NKEY_SEED_FILE"] = str(self._seed_file)
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


# --- sender identity: the signed reverse leg ------------------------------------------

# The probe discovers by agent + owner only, so each host gets its own owner.
SIGNED_OWNER = "pytest-reverse-signed"
ANY_OWNER = "pytest-reverse-any"


@pytest.fixture
def alice_seed_file(tmp_path: Path, identity_keys: dict[str, NkeyUser]) -> Path:
    """alice's seed in a 0600 file — what the probe (and any runner) takes."""
    seed_file = tmp_path / "alice.nk"
    seed_file.write_text(identity_keys["alice"].seed + "\n", encoding="utf-8")
    seed_file.chmod(0o600)
    return seed_file


@pytest.fixture
def ts_client_probe_alice(
    nats_server_nkey: RunningServer, alice_seed_file: Path
) -> _TsClientProcess:
    reason = _interop_prereqs_missing()
    if reason is not None:
        pytest.skip(reason)
    return _TsClientProcess(nats_server_nkey.url, seed_file=alice_seed_file)


class _Echoing:
    """An echo service whose handler records the classified sender."""

    def __init__(self, service: AgentService) -> None:
        self.service = service
        self.senders: list[SenderInfo | None] = []


async def _start_echo(nc: NATSClient, *, owner: str, seed: str, min_sender_trust: str) -> _Echoing:
    service = AgentService(
        agent=AGENT,
        owner=owner,
        session_name="reverse-identity",
        nc=nc,
        description="reverse-interop identity echo agent",
        heartbeat_interval_s=1,
        identity=ServiceIdentity(signer=signer_from_seed(seed)),
        min_sender_trust=min_sender_trust,  # type: ignore[arg-type]
    )
    echoing = _Echoing(service)

    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        echoing.senders.append(stream.sender)
        text = envelope.prompt
        if stream.sender is not None:
            text += f" sender: {format_sender(stream.sender)}"
        await stream.send(text)

    service.on_prompt(handler)
    await service.start()
    return echoing


@pytest_asyncio.fixture
async def identity_services(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> AsyncIterator[tuple[_Echoing, _Echoing]]:
    """(signed, any): two Python hosts as alice on ``nkey-noaccounts.conf``."""
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    seed = identity_keys["alice"].seed
    signed = await _start_echo(nc, owner=SIGNED_OWNER, seed=seed, min_sender_trust="signed")
    anyone = await _start_echo(nc, owner=ANY_OWNER, seed=seed, min_sender_trust="any")
    try:
        yield signed, anyone
    finally:
        await signed.service.stop()
        await anyone.service.stop()


@pytest.mark.asyncio
async def test_signed_ts_probe_is_verified_by_the_python_host(
    identity_services: tuple[_Echoing, _Echoing],
    ts_client_probe_alice: _TsClientProcess,
    identity_keys: dict[str, NkeyUser],
    request: pytest.FixtureRequest,
) -> None:
    """TS caller signs → Python host verifies, echoes `(verified user, claimed account)`."""
    signed, _ = identity_services
    alice_id = AgentId.new("$G", identity_keys["alice"].public)
    result = await ts_client_probe_alice.prompt(
        agent=AGENT, owner=SIGNED_OWNER, prompt="hello from bun", signed=True
    )
    EvidenceRecorder.for_test(EVIDENCE_ROOT, request.node.nodeid).write_json(
        "probe.json",
        {
            "prompt_subject": signed.service.subject.prompt,
            "host_identity": signed.service.identity,
            "returncode": result.returncode,
            "lines": result.lines,
            "stderr": result.stderr,
        },
    )
    assert result.returncode == 0, (
        f"probe failed (code={result.returncode}); stderr:\n{result.stderr}"
    )
    # The probe's first line is its own identity — alice on both ends here.
    assert result.lines[0] == {"type": "identity", "id": str(alice_id)}
    assert result.identity == str(alice_id) == str(signed.service.identity)
    assert result.done is not None and result.done["chunks"] == len(result.chunks)
    assert result.chunks[0] == {"type": "status", "status": "ack"}
    responses = [c["text"] for c in result.chunks if c["type"] == "response"]
    assert responses == [f"hello from bun sender: {alice_id} (verified user, claimed account)"]
    assert responses[0].endswith("(verified user, claimed account)")
    assert len(signed.senders) == 1 and str(signed.senders[0]).startswith(str(alice_id))


@pytest.mark.asyncio
async def test_unsigned_ts_probe_is_refused_by_a_signed_endpoint_before_publishing(
    identity_services: tuple[_Echoing, _Echoing],
    ts_client_probe_alice: _TsClientProcess,
) -> None:
    """No `--signed` against `min_sender_trust: signed` → SenderSignatureRequiredError, exit 1."""
    signed, _ = identity_services
    result = await ts_client_probe_alice.prompt(
        agent=AGENT, owner=SIGNED_OWNER, prompt="unsigned", timeout_s=3.0
    )
    assert result.returncode == PROBE_EXIT_ERROR, result.stderr
    assert result.done is None
    error = result.error
    assert error is not None and error["name"] == "SenderSignatureRequiredError"
    assert signed.senders == []  # thrown before publishing: the host never saw it


@pytest.mark.asyncio
async def test_unsigned_ts_probe_arrives_with_no_sender_on_an_any_endpoint(
    identity_services: tuple[_Echoing, _Echoing],
    ts_client_probe_alice: _TsClientProcess,
) -> None:
    """Without `--signed` the probe sends no header at all: the host sees `sender is None`."""
    _, anyone = identity_services
    result = await ts_client_probe_alice.prompt(
        agent=AGENT, owner=ANY_OWNER, prompt="plain", signed=False
    )
    assert result.returncode == 0, result.stderr
    assert result.identity is None
    responses = [c["text"] for c in result.chunks if c["type"] == "response"]
    assert responses == ["plain"]  # no ` sender: …` suffix: absent, not claimed
    assert anyone.senders == [None]

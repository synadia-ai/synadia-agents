"""Cross-SDK interop — Python client against the TypeScript reference agent.

Spawns the TS SDK's reference agent via ``bun run
../typescript/examples/_run-reference-agent.ts``, points it at the
session's ``nats-server`` via ``NATS_URL``, and verifies the Python client
can discover it, read its spec-compliant metadata + endpoint caps, and
round-trip a prompt.

The TS SDK lives in the same monorepo as a sibling subdir
(``../typescript/`` from this package's root). The test skips cleanly —
NOT fails — when:

  - ``bun`` is not on PATH,
  - ``../typescript/`` doesn't exist (unexpected in a fresh checkout), or
  - the subprocess fails to come up (missing ``node_modules``, broken
    install, etc).

Why not just spin up a second Python agent and call that "interop"? The
whole point is to catch shape drifts that only show up when bytes hit a
different implementation. A TS-side change that silently broke the
envelope, chunk, or heartbeat shape would cascade into the Python SDK's
next cross-SDK release if we didn't exercise both implementations on the
same wire.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from natsagent import Client, ResponseChunk

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient

    from tests.harness.nats_server import RunningServer


# Sibling subdir inside the monorepo: client-sdk/python/ and
# client-sdk/typescript/ live next to each other.
TSSDK_DIR = Path(__file__).resolve().parent.parent.parent / "typescript"
REFERENCE_AGENT_SCRIPT = TSSDK_DIR / "examples" / "_run-reference-agent.ts"

# The reference agent prints this line on startup; we wait for it rather
# than guessing a sleep duration.
READY_MARKER = "reference agent listening on "

STARTUP_TIMEOUT_S = 20.0  # `bun run` cold start + nats connect


def _interop_prereqs_missing() -> str | None:
    """Return a skip-reason if any prereq is missing, else None."""
    if shutil.which("bun") is None:
        return "bun not on PATH — skipping cross-SDK interop test"
    if not TSSDK_DIR.is_dir():
        return (
            f"TS SDK sibling subdir not found at {TSSDK_DIR} — "
            "unexpected in a fresh monorepo checkout"
        )
    if not REFERENCE_AGENT_SCRIPT.is_file():
        return f"reference agent script missing at {REFERENCE_AGENT_SCRIPT}"
    if not (TSSDK_DIR / "node_modules").is_dir():
        return (
            f"TS SDK dependencies not installed — "
            f"run `bun install` in {TSSDK_DIR} to enable interop tests"
        )
    return None


class _ReferenceAgentProcess:
    """Manage the bun subprocess lifecycle.

    ``bun run`` inherits our env but we override ``NATS_URL`` to point at
    the test's session-scoped server. The subprocess prints its prompt
    subject to stdout; we parse that line and expose it as
    ``prompt_subject`` so the test can assert what the TS side thinks
    it's listening on.
    """

    def __init__(self, nats_url: str) -> None:
        self._nats_url = nats_url
        self._proc: subprocess.Popen[str] | None = None
        self.prompt_subject: str | None = None
        self.stdout_tail: list[str] = []

    async def start(self) -> None:
        env = {**os.environ, "NATS_URL": self._nats_url}
        self._proc = subprocess.Popen(
            ["bun", "run", str(REFERENCE_AGENT_SCRIPT)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(TSSDK_DIR),
            env=env,
            text=True,
            bufsize=1,
        )
        # Read stdout until we see READY_MARKER, or the process exits, or
        # we hit STARTUP_TIMEOUT_S.
        deadline = asyncio.get_event_loop().time() + STARTUP_TIMEOUT_S
        assert self._proc.stdout is not None
        while asyncio.get_event_loop().time() < deadline:
            line = await asyncio.get_event_loop().run_in_executor(None, self._proc.stdout.readline)
            if not line:  # EOF — subprocess died
                code = self._proc.poll()
                raise RuntimeError(
                    f"reference agent exited before ready (code={code}); "
                    f"tail:\n{''.join(self.stdout_tail[-20:])}"
                )
            self.stdout_tail.append(line)
            if READY_MARKER in line:
                self.prompt_subject = line.split(READY_MARKER, 1)[1].strip()
                return
        raise TimeoutError(
            f"reference agent did not print READY_MARKER within {STARTUP_TIMEOUT_S}s; "
            f"tail:\n{''.join(self.stdout_tail[-20:])}"
        )

    async def stop(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            return
        self._proc.terminate()
        try:
            await asyncio.get_event_loop().run_in_executor(
                None, lambda: self._proc.wait(timeout=5) if self._proc else None
            )
        except subprocess.TimeoutExpired:
            self._proc.kill()


@pytest.fixture
def interop_skip_reason() -> str | None:
    return _interop_prereqs_missing()


@pytest.fixture
async def ts_reference_agent(
    nats_server: RunningServer, interop_skip_reason: str | None
) -> AsyncIterator[_ReferenceAgentProcess]:
    if interop_skip_reason is not None:
        pytest.skip(interop_skip_reason)
    proc = _ReferenceAgentProcess(nats_server.url)
    await proc.start()
    try:
        yield proc
    finally:
        await proc.stop()


@pytest.mark.xfail(
    reason="TS SDK still on protocol v0.1 (service name 'SynadiaAgents'); "
    "re-enable once ../typescript/ bumps to v0.2 ('agents' + queue group).",
    strict=False,
)
@pytest.mark.asyncio
async def test_python_client_discovers_ts_reference_agent(
    nc: NATSClient, ts_reference_agent: _ReferenceAgentProcess
) -> None:
    """Python `Client.discover()` sees the TS agent with spec-compliant metadata."""
    assert ts_reference_agent.prompt_subject is not None

    client = Client(nc=nc)
    await client.start()
    try:
        found = await client.discover(timeout=3.0)
        inboxes = [d.inbox for d in found]
        assert ts_reference_agent.prompt_subject in inboxes, (
            f"TS agent not discovered by Python client. "
            f"Expected {ts_reference_agent.prompt_subject!r} in {inboxes!r}"
        )
        discovered = next(d for d in found if d.inbox == ts_reference_agent.prompt_subject)

        # §3.2 — the agent publishes these via service metadata.
        assert discovered.agent == "demo-agent"
        assert discovered.owner == os.environ.get("USER", "anon")

        # §2.1 — the prompt endpoint declares its caps.
        assert discovered.prompt_endpoint.name == "prompt"
        assert discovered.prompt_endpoint.max_payload_bytes == 1024 * 1024
        assert discovered.prompt_endpoint.attachments_ok is True
    finally:
        await client.stop()


@pytest.mark.xfail(
    reason="TS SDK still on protocol v0.1 (service name 'SynadiaAgents'); "
    "re-enable once ../typescript/ bumps to v0.2 ('agents' + queue group).",
    strict=False,
)
@pytest.mark.asyncio
async def test_python_client_prompts_ts_reference_agent(
    nc: NATSClient, ts_reference_agent: _ReferenceAgentProcess
) -> None:
    """Python client round-trips a prompt through the TS reference agent.

    Note: the caller-supplied request-envelope ``session`` field is an SDK
    convention tolerated per §5.6; it is NOT yet surfaced by the TS SDK —
    its ``RequestEnvelope`` does not include ``session``. Sending the
    field is still safe on the wire (§5.6 tolerance), but an end-to-end
    session assertion across PY → TS has to wait for a matching TS PR.
    Until then, this test only exercises the session-less path; the
    session-bearing round-trip is covered intra-SDK by
    ``tests/test_session_e2e.py``.
    """
    assert ts_reference_agent.prompt_subject is not None

    client = Client(nc=nc)
    await client.start()
    try:
        found = await client.discover(timeout=3.0)
        discovered = next(d for d in found if d.inbox == ts_reference_agent.prompt_subject)
        remote = client.bind(discovered)

        received: list[ResponseChunk] = []
        async for msg in remote.prompt("hello from python", timeout=10.0):
            assert isinstance(msg, ResponseChunk), (
                f"TS agent emitted unexpected chunk type: {type(msg).__name__}"
            )
            received.append(msg)

        # The reference agent is hardcoded to emit exactly one response chunk.
        assert len(received) == 1
        assert received[0].text == "demo agent received your prompt."
    finally:
        await client.stop()

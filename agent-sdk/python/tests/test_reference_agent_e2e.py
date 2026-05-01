"""E2E: the ``examples/_reference_agent.py`` subprocess echoes + saves attachments.

Exercises the example-specific behaviour that no other test covers:

* prompt is echoed back with the configured prefix
* inbound attachment filenames are appended to the echo text
* attachments are written to disk under ``--save-attachments-to-dir``

The client-side numbered examples (01-05) are thin wrappers around
already-tested SDK methods — subprocess-stdout scraping there is brittle
for low value. This single test is the guardrail for the reference agent.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from synadia_ai.agents import Agents, Attachment, ResponseChunk

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient

    from tests.harness.nats_server import RunningServer


REPO_ROOT = Path(__file__).resolve().parent.parent
REFERENCE_AGENT_SCRIPT = REPO_ROOT / "examples" / "_reference_agent.py"

# Line the reference agent prints as soon as it's ready.
READY_MARKER = "reference agent listening on "
STARTUP_TIMEOUT_S = 15.0


class _PyReferenceAgent:
    """Manage the python reference-agent subprocess lifecycle."""

    def __init__(self, *, nats_url: str, save_dir: Path, prefix: str) -> None:
        self._nats_url = nats_url
        self._save_dir = save_dir
        self._prefix = prefix
        self._proc: subprocess.Popen[str] | None = None
        self.prompt_subject: str | None = None
        self.stdout_tail: list[str] = []

    async def start(self) -> None:
        self._proc = subprocess.Popen(
            [
                sys.executable,
                # Force unbuffered stdio so the "ready" marker reaches us as
                # soon as it is printed — without -u the pipe block-buffers.
                "-u",
                str(REFERENCE_AGENT_SCRIPT),
                "--url",
                self._nats_url,
                "--save-attachments-to-dir",
                str(self._save_dir),
                "--prefix",
                self._prefix,
                "--heartbeat-interval",
                "1",
                "--session-name",
                "pyref-e2e",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(REPO_ROOT),
            text=True,
            bufsize=1,
        )
        deadline = asyncio.get_event_loop().time() + STARTUP_TIMEOUT_S
        assert self._proc.stdout is not None
        while asyncio.get_event_loop().time() < deadline:
            line = await asyncio.get_event_loop().run_in_executor(None, self._proc.stdout.readline)
            if not line:  # EOF: subprocess died before signalling ready.
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
            f"reference agent did not signal ready within {STARTUP_TIMEOUT_S}s; "
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
async def py_reference_agent(
    nats_server: RunningServer, tmp_path: Path
) -> AsyncIterator[tuple[_PyReferenceAgent, Path]]:
    save_dir = tmp_path / "attach"
    save_dir.mkdir(parents=True, exist_ok=True)
    proc = _PyReferenceAgent(nats_url=nats_server.url, save_dir=save_dir, prefix="py-ref: ")
    await proc.start()
    try:
        yield proc, save_dir
    finally:
        await proc.stop()


async def test_reference_agent_echoes_prefix_and_saves_attachment(
    nc: NATSClient,
    py_reference_agent: tuple[_PyReferenceAgent, Path],
) -> None:
    proc, save_dir = py_reference_agent
    assert proc.prompt_subject is not None

    agents = Agents(nc=nc)
    try:
        found = await agents.discover(timeout=3.0)
        discovered = next((a for a in found if a.prompt_subject == proc.prompt_subject), None)
        assert discovered is not None, (
            f"python reference agent not discovered; subjects={[a.prompt_subject for a in found]}"
        )

        received: list[ResponseChunk] = []
        async for msg in discovered.prompt(
            "hello", attachments=[Attachment.from_bytes("note.txt", b"ping")], timeout=10.0
        ):
            assert isinstance(msg, ResponseChunk), f"unexpected chunk type: {type(msg).__name__}"
            received.append(msg)

        assert len(received) == 1
        assert received[0].text == "py-ref: hello [received 1 attachment(s): note.txt]"

        saved = save_dir / "note.txt"
        assert saved.exists(), (
            f"expected saved attachment at {saved}, dir={list(save_dir.iterdir())}"
        )
        assert saved.read_bytes() == b"ping"
    finally:
        await agents.close()

"""E2E: the reference agent's per-session conversation memory.

The `examples/_reference_agent.py` reference agent keys its in-process
conversation memory on `envelope.session`, with the ``None`` bucket serving
session-less callers (subject-level session pattern, §2 + §3.2). This test
proves the demonstration actually works end-to-end:

- **Subject-level:** two session-less prompts → the second response recaps
  the first.
- **Envelope-level:** two prompts with `--session alice`, interleaved with a
  `--session bob` prompt → alice's second turn recaps her first, not bob's.

No other test exercises the reference agent's memory. Without this, a
regression that silently drops the history dict would ship green.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from natsagent import Agents, ResponseChunk

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient

    from tests.harness.nats_server import RunningServer


REPO_ROOT = Path(__file__).resolve().parent.parent
REFERENCE_AGENT_SCRIPT = REPO_ROOT / "examples" / "_reference_agent.py"

READY_MARKER = "reference agent listening on "
STARTUP_TIMEOUT_S = 15.0


class _RefAgentProc:
    def __init__(self, nats_url: str) -> None:
        self._nats_url = nats_url
        self._proc: subprocess.Popen[str] | None = None
        self.prompt_subject: str | None = None
        self._stdout_tail: list[str] = []

    async def start(self) -> None:
        self._proc = subprocess.Popen(
            [
                sys.executable,
                "-u",
                str(REFERENCE_AGENT_SCRIPT),
                "--url",
                self._nats_url,
                "--heartbeat-interval",
                "1",
                "--name",
                "session-mem-e2e",
                "--prefix",
                "",  # simpler assertions without a fixed echo prefix
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
            if not line:
                code = self._proc.poll()
                raise RuntimeError(
                    f"reference agent exited (code={code}); "
                    f"tail:\n{''.join(self._stdout_tail[-20:])}"
                )
            self._stdout_tail.append(line)
            if READY_MARKER in line:
                self.prompt_subject = line.split(READY_MARKER, 1)[1].strip()
                return
        raise TimeoutError(
            f"reference agent not ready in {STARTUP_TIMEOUT_S}s; "
            f"tail:\n{''.join(self._stdout_tail[-20:])}"
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
async def ref_agent(nats_server: RunningServer) -> AsyncIterator[_RefAgentProc]:
    proc = _RefAgentProc(nats_server.url)
    await proc.start()
    try:
        yield proc
    finally:
        await proc.stop()


async def _collect_text(agent: object, text: str, *, session: str | None = None) -> str:
    chunks: list[ResponseChunk] = []
    async for msg in agent.prompt(text, session=session, timeout=10.0):  # type: ignore[attr-defined]
        assert isinstance(msg, ResponseChunk), f"unexpected chunk: {type(msg).__name__}"
        chunks.append(msg)
    assert len(chunks) == 1
    return chunks[0].text


@pytest.mark.asyncio
async def test_subject_level_chat_remembers_prior_turn(
    nc: NATSClient, ref_agent: _RefAgentProc
) -> None:
    """Two session-less prompts share the ``None`` history bucket — the
    second response MUST reference the first prompt by text. This is the
    ``02-prompt-text.py "hi" && 02-prompt-text.py "what did I say?"``
    demo, asserted automatically."""
    assert ref_agent.prompt_subject is not None
    agents = Agents(nc=nc)
    try:
        found = await agents.discover(timeout=3.0)
        discovered = next(a for a in found if a.prompt_subject == ref_agent.prompt_subject)

        first = await _collect_text(discovered, "hi, I'm rene")
        # First turn has no prior history.
        assert "previously said" not in first

        second = await _collect_text(discovered, "what did I say?")
        # Second turn must recap the first.
        assert "previously said" in second
        assert '"hi, I\'m rene"' in second
        assert "this subject" in second  # session-less marker
    finally:
        await agents.close()


@pytest.mark.asyncio
async def test_envelope_level_sessions_are_independent(
    nc: NATSClient, ref_agent: _RefAgentProc
) -> None:
    """alice and bob hit the SAME subject but carry different envelope
    sessions — their histories MUST NOT bleed. A follow-up to alice
    recaps her prior turn; it MUST NOT mention bob's."""
    assert ref_agent.prompt_subject is not None
    agents = Agents(nc=nc)
    try:
        found = await agents.discover(timeout=3.0)
        discovered = next(a for a in found if a.prompt_subject == ref_agent.prompt_subject)

        alice_1 = await _collect_text(discovered, "I am alice", session="alice")
        assert "previously said" not in alice_1

        bob_1 = await _collect_text(discovered, "I am bob", session="bob")
        # Bob's first turn sees no history — his bucket is empty.
        assert "previously said" not in bob_1

        alice_2 = await _collect_text(discovered, "who am I?", session="alice")
        # Alice's second turn recaps alice's first — and ONLY alice's.
        assert "previously said" in alice_2
        assert '"I am alice"' in alice_2
        assert '"I am bob"' not in alice_2
        assert "session 'alice'" in alice_2
    finally:
        await agents.close()

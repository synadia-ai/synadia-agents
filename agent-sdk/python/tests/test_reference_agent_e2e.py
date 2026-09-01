"""E2E: the ``examples/_reference_agent.py`` subprocess echoes + saves attachments.

Exercises the example-specific behaviour that no other test covers:

* prompt is echoed back with the configured prefix
* inbound attachment filenames are appended to the echo text
* attachments are written to disk under ``--save-attachments-to-dir``
* ``--nkey`` + ``--sender-identity signed`` + ``--min-sender-trust signed``:
  the agent prints its identity
  after the ready marker, registers a verifying ``id_sig``, refuses
  unsigned callers and appends the formatted sender to the echo

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
from synadia_ai.agents import (
    AgentId,
    Agents,
    Attachment,
    Identity,
    ResponseChunk,
    SenderSignatureRequiredError,
    StatusChunk,
    signer_from_seed,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient

    from tests.conftest import ConnectNkeyUser, NkeyUser
    from tests.harness.nats_server import RunningServer


REPO_ROOT = Path(__file__).resolve().parent.parent
REFERENCE_AGENT_SCRIPT = REPO_ROOT / "examples" / "_reference_agent.py"

# Line the reference agent prints as soon as it's ready; the next line names
# the identity it registered (`identity: <id> (min_sender_trust=…)` or
# `identity: none (…)`).
READY_MARKER = "reference agent listening on "
IDENTITY_MARKER = "identity: "
STARTUP_TIMEOUT_S = 15.0


class _PyReferenceAgent:
    """Manage the python reference-agent subprocess lifecycle."""

    def __init__(
        self,
        *,
        nats_url: str,
        save_dir: Path,
        prefix: str,
        session_name: str = "pyref-e2e",
        extra_args: tuple[str, ...] = (),
    ) -> None:
        self._nats_url = nats_url
        self._save_dir = save_dir
        self._prefix = prefix
        self._session_name = session_name
        self._extra_args = extra_args
        self._proc: subprocess.Popen[str] | None = None
        self.prompt_subject: str | None = None
        self.identity_line: str | None = None
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
                self._session_name,
                *self._extra_args,
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
                # The identity line follows the marker on its own line.
                next_line = await asyncio.get_event_loop().run_in_executor(
                    None, self._proc.stdout.readline
                )
                self.stdout_tail.append(next_line)
                if IDENTITY_MARKER in next_line:
                    self.identity_line = next_line.split(IDENTITY_MARKER, 1)[1].strip()
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
    # No-auth server: no identity, the extension is still advertised.
    assert proc.identity_line == "none (min_sender_trust=any)"

    agents = Agents(nc=nc)
    try:
        found = await agents.discover(timeout=3.0)
        discovered = next((a for a in found if a.prompt_subject == proc.prompt_subject), None)
        assert discovered is not None, (
            f"python reference agent not discovered; subjects={[a.prompt_subject for a in found]}"
        )

        received: list[ResponseChunk | StatusChunk] = []
        async for msg in discovered.prompt(
            "hello", attachments=[Attachment.from_bytes("note.txt", b"ping")], timeout=10.0
        ):
            assert isinstance(msg, ResponseChunk | StatusChunk), (
                f"unexpected chunk type: {type(msg).__name__}"
            )
            received.append(msg)

        # The reference agent inherits the §6.4 leading ack from the SDK; the
        # handler contributes a single ResponseChunk.
        responses = [c for c in received if isinstance(c, ResponseChunk)]
        assert len(responses) == 1
        assert responses[0].text == "py-ref: hello [received 1 attachment(s): note.txt]"

        saved = save_dir / "note.txt"
        assert saved.exists(), (
            f"expected saved attachment at {saved}, dir={list(save_dir.iterdir())}"
        )
        assert saved.read_bytes() == b"ping"
    finally:
        await agents.close()


# --- sender identity: one nkey connection bundle + explicit signed mode ------------


@pytest.fixture
async def py_reference_agent_signed(
    nats_server_nkey: RunningServer, tmp_path: Path, identity_keys: dict[str, NkeyUser]
) -> AsyncIterator[_PyReferenceAgent]:
    """The Python reference agent as alice on ``nkey-noaccounts.conf``, requiring signed senders."""
    seed_file = tmp_path / "alice.nk"
    seed_file.write_text(identity_keys["alice"].seed + "\n", encoding="utf-8")
    seed_file.chmod(0o600)
    proc = _PyReferenceAgent(
        nats_url=nats_server_nkey.url,
        save_dir=tmp_path / "attach",
        prefix="py-ref: ",
        session_name="pyref-signed",
        extra_args=(
            "--nkey",
            str(seed_file),
            "--sender-identity",
            "signed",
            "--min-sender-trust",
            "signed",
        ),
    )
    await proc.start()
    try:
        yield proc
    finally:
        await proc.stop()


async def test_reference_agent_with_nkey_verifies_signed_callers(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    py_reference_agent_signed: _PyReferenceAgent,
) -> None:
    proc = py_reference_agent_signed
    alice = identity_keys["alice"]
    alice_id = AgentId.new("$G", alice.public)
    assert proc.identity_line == f"{alice_id} (min_sender_trust=signed)"

    nc = await connect_nkey_user(nats_server_nkey, "alice")
    signed = Agents(nc=nc, identity=Identity(signer=signer_from_seed(alice.seed), name="py"))
    unsigned = Agents(nc=nc)
    try:
        found = await signed.discover(timeout=3.0)
        discovered = next(a for a in found if a.prompt_subject == proc.prompt_subject)
        assert discovered.identity == alice_id and discovered.id_sig_verified is True
        assert discovered.min_sender_trust == "signed"
        received = [m async for m in discovered.prompt("hello", timeout=10.0)]
        responses = [c for c in received if isinstance(c, ResponseChunk)]
        assert len(responses) == 1
        assert responses[0].text == (
            f"py-ref: hello sender: {alice_id} (verified user, claimed account)"
        )
        hb = await discovered.status()
        assert hb.agent == "demo-agent"
        # An unsigned caller is refused before publishing (the endpoint says `signed`).
        plain = next(
            a
            for a in await unsigned.discover(timeout=3.0)
            if a.prompt_subject == proc.prompt_subject
        )
        with pytest.raises(SenderSignatureRequiredError):
            plain.prompt("hi")
    finally:
        await signed.close()
        await unsigned.close()

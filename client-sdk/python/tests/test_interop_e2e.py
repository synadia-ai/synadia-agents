"""Cross-SDK interop — Python client against the TypeScript reference agent.

Spawns the TS SDK's reference agent via ``bun run
../typescript/examples/_run-reference-agent.ts``, points it at the
session's ``nats-server`` via ``NATS_URL``, and verifies the Python client
can discover it, read its spec-compliant metadata + endpoint caps, and
round-trip a prompt.

The sender-identity leg (T1 of the plan's matrix) runs the same runner on
``nkey-noaccounts.conf`` with ``NATS_NKEY_SEED_FILE`` and
``REFERENCE_AGENT_MIN_SENDER_TRUST=signed``: the Python caller signs
``Agent-Sender``, the TS host verifies it and echoes the formatted
sender; discovery sees the identity metadata the TS host registered.

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

from synadia_ai.agents import (
    AgentId,
    Agents,
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


# Sibling subdir inside the monorepo: client-sdk/python/ and
# client-sdk/typescript/ live next to each other.
TSSDK_DIR = Path(__file__).resolve().parent.parent.parent / "typescript"
REFERENCE_AGENT_SCRIPT = TSSDK_DIR / "examples" / "_run-reference-agent.ts"

# The reference agent prints this line on startup; we wait for it rather
# than guessing a sleep duration. The line after it names the identity
# it resolved (`identity: <id> (min_sender_trust=…)` or `identity: none (…)`).
READY_MARKER = "reference agent listening on "
IDENTITY_MARKER = "identity: "

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

    def __init__(self, nats_url: str, env: dict[str, str] | None = None) -> None:
        self._nats_url = nats_url
        self._env = env or {}
        self._proc: subprocess.Popen[str] | None = None
        self.prompt_subject: str | None = None
        self.identity_line: str | None = None
        self.stdout_tail: list[str] = []

    async def start(self) -> None:
        env = {**os.environ, "NATS_URL": self._nats_url, **self._env}
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
                # The identity line follows the marker (its own line, so the
                # marker scrape above stays verbatim).
                next_line = await asyncio.get_event_loop().run_in_executor(
                    None, self._proc.stdout.readline
                )
                self.stdout_tail.append(next_line)
                if IDENTITY_MARKER in next_line:
                    self.identity_line = next_line.split(IDENTITY_MARKER, 1)[1].strip()
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


@pytest.mark.asyncio
async def test_python_client_discovers_ts_reference_agent(
    nc: NATSClient, ts_reference_agent: _ReferenceAgentProcess
) -> None:
    """Python `Agents.discover()` sees the TS agent with spec-compliant metadata."""
    assert ts_reference_agent.prompt_subject is not None

    agents = Agents(nc=nc)
    try:
        found = await agents.discover(timeout=3.0)
        subjects = [a.prompt_subject for a in found]
        assert ts_reference_agent.prompt_subject in subjects, (
            f"TS agent not discovered by Python client. "
            f"Expected {ts_reference_agent.prompt_subject!r} in {subjects!r}"
        )
        discovered = next(a for a in found if a.prompt_subject == ts_reference_agent.prompt_subject)

        # §3.2 — the agent publishes these via service metadata.
        assert discovered.agent == "demo-agent"
        assert discovered.owner == os.environ.get("USER", "anon")

        # §2.1 — the prompt endpoint declares its caps.
        assert discovered.prompt_endpoint.name == "prompt"
        assert discovered.prompt_endpoint.max_payload_bytes == 1024 * 1024
        assert discovered.prompt_endpoint.attachments_ok is True
    finally:
        await agents.close()


@pytest.mark.asyncio
async def test_python_client_prompts_ts_reference_agent(
    nc: NATSClient, ts_reference_agent: _ReferenceAgentProcess
) -> None:
    """Python client round-trips a prompt through the TS reference agent."""
    assert ts_reference_agent.prompt_subject is not None

    agents = Agents(nc=nc)
    try:
        found = await agents.discover(timeout=3.0)
        discovered = next(a for a in found if a.prompt_subject == ts_reference_agent.prompt_subject)

        received: list[ResponseChunk | StatusChunk] = []
        async for msg in discovered.prompt("hello from python", timeout=10.0):
            # Spec-compliant agents emit a §6.4 leading `status=ack` chunk
            # before the handler's first response chunk. The TS reference
            # agent was updated to do this in lockstep with the Python
            # agent-sdk (parallel branch `sdk-mandatory-initial-ack`); pre-
            # update it sent only ResponseChunks. Accept both, then filter
            # responses for the content assertion so this test stays green
            # across the cross-SDK rollout window.
            assert isinstance(msg, ResponseChunk | StatusChunk), (
                f"TS agent emitted unexpected chunk type: {type(msg).__name__}"
            )
            received.append(msg)

        # The reference agent is hardcoded to emit exactly one response chunk;
        # the §6.4 leading ack (if present) is an SDK-level concern, not a
        # property of the reference-agent handler under test here.
        responses = [c for c in received if isinstance(c, ResponseChunk)]
        assert len(responses) == 1, f"expected 1 response chunk, got: {received!r}"
        assert responses[0].text == "demo agent received your prompt."
    finally:
        await agents.close()


@pytest.mark.asyncio
async def test_python_client_uses_one_mux_sub_for_n_prompts_against_ts_agent(
    nc: NATSClient, ts_reference_agent: _ReferenceAgentProcess
) -> None:
    """Wire-economy regression vs the TS agent: 5 prompts → 1 mux SUB.

    Pre-PR the Python client opened a fresh ``_INBOX.agents.<nuid>``
    subscription per prompt (one SUB+UNSUB+flush per call). The
    interim mux-inbox refactor (`_mux.py`) consolidates those into
    a single shared ``_INBOX.agents.<mux>.*`` SUB per :class:`Agents`.
    Counts inbox-prefixed ``nc.subscribe()`` calls during a 5-prompt
    sequence — should be exactly **1**.
    """
    assert ts_reference_agent.prompt_subject is not None

    inbox_subscribes: list[str] = []
    original_subscribe = nc.subscribe

    async def counting_subscribe(subject: str, *args: object, **kwargs: object) -> object:
        if subject.startswith("_INBOX.agents."):
            inbox_subscribes.append(subject)
        return await original_subscribe(subject, *args, **kwargs)  # type: ignore[arg-type]

    nc.subscribe = counting_subscribe  # type: ignore[method-assign,assignment]

    try:
        agents = Agents(nc=nc)
        try:
            found = await agents.discover(timeout=3.0)
            discovered = next(
                a for a in found if a.prompt_subject == ts_reference_agent.prompt_subject
            )
            baseline = len(inbox_subscribes)
            for _ in range(5):
                received_count = 0
                async for _msg in discovered.prompt("ping", timeout=10.0):
                    received_count += 1
                assert received_count >= 1
            opened = inbox_subscribes[baseline:]
        finally:
            await agents.close()
    finally:
        nc.subscribe = original_subscribe  # type: ignore[method-assign]

    assert len(opened) == 1, (
        f"expected 1 mux inbox SUB across 5 prompts to TS agent; opened {len(opened)}: {opened!r}"
    )
    assert opened[0].startswith("_INBOX.agents.")


# --- sender identity: the T1 interop leg ------------------------------------------


@pytest.fixture
async def ts_reference_agent_signed(
    nats_server_nkey: RunningServer,
    interop_skip_reason: str | None,
    identity_keys: dict[str, NkeyUser],
    tmp_path: Path,
) -> AsyncIterator[_ReferenceAgentProcess]:
    """The TS runner as alice on ``nkey-noaccounts.conf``, requiring signed senders.

    The seed goes through a file (``NATS_NKEY_SEED_FILE``, mode 0600) — never
    an environment value every spawned tool process would inherit.
    """
    if interop_skip_reason is not None:
        pytest.skip(interop_skip_reason)
    seed_file = tmp_path / "alice.nk"
    seed_file.write_text(identity_keys["alice"].seed + "\n", encoding="utf-8")
    seed_file.chmod(0o600)
    proc = _ReferenceAgentProcess(
        nats_server_nkey.url,
        env={
            "NATS_NKEY_SEED_FILE": str(seed_file),
            "NATS_SENDER_IDENTITY": "signed",
            "REFERENCE_AGENT_MIN_SENDER_TRUST": "signed",
        },
    )
    await proc.start()
    try:
        yield proc
    finally:
        await proc.stop()


@pytest.mark.asyncio
async def test_python_signed_caller_against_ts_signed_reference_agent(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    ts_reference_agent_signed: _ReferenceAgentProcess,
) -> None:
    """Discovery sees the TS host's identity metadata; a signed prompt is verified and echoed."""
    alice = identity_keys["alice"]
    alice_id = AgentId.new("$G", alice.public)
    assert ts_reference_agent_signed.identity_line == f"{alice_id} (min_sender_trust=signed)"

    nc = await connect_nkey_user(nats_server_nkey, "alice")
    agents = Agents(nc=nc, identity=Identity(signer=signer_from_seed(alice.seed), name="py"))
    try:
        found = await agents.discover(timeout=3.0)
        subject = ts_reference_agent_signed.prompt_subject
        discovered = next(a for a in found if a.prompt_subject == subject)
        assert discovered.supports_sender_identity is True
        assert discovered.min_sender_trust == "signed"
        assert discovered.identity == alice_id == await agents.self_id()
        assert discovered.id_sig_verified is True

        received = [m async for m in discovered.prompt("hello from python", timeout=10.0)]
        assert all(isinstance(m, ResponseChunk | StatusChunk) for m in received)
        responses = [c for c in received if isinstance(c, ResponseChunk)]
        assert len(responses) == 1
        assert responses[0].text == (
            f"demo agent received your prompt. sender: {alice_id} (verified user, claimed account)"
        )
        assert responses[0].text.endswith(f"{alice_id} (verified user, claimed account)")

        hb = await discovered.status()
        assert hb.agent == "demo-agent"
    finally:
        await agents.close()


@pytest.mark.asyncio
async def test_python_unsigned_caller_is_refused_by_ts_signed_reference_agent(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    ts_reference_agent_signed: _ReferenceAgentProcess,
) -> None:
    """No signer → `SenderSignatureRequiredError` at call time; a raw request → 401 on the wire."""
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    agents = Agents(nc=nc)  # unsigned claims only
    try:
        found = await agents.discover(timeout=3.0)
        subject = ts_reference_agent_signed.prompt_subject
        discovered = next(a for a in found if a.prompt_subject == subject)
        with pytest.raises(SenderSignatureRequiredError):
            discovered.prompt("hi")
        assert subject is not None
        reply = await nc.request(subject, b'{"prompt":"hi"}', timeout=3.0)
        assert reply.headers is not None
        assert reply.headers["Nats-Service-Error-Code"] == "401"
        assert reply.headers["Nats-Service-Error"] == "signature required"
    finally:
        await agents.close()

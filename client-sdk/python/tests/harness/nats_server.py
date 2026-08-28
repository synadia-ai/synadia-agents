"""Spawn a local `nats-server` for integration tests.

Skips integration tests cleanly if `nats-server` is not on PATH. We do not
bundle or auto-download the server — it's a Go binary the user installs via
`brew install nats-server` (macOS) or their distro's instructions.

:func:`start_server` composes three things on the command line: the
``-a/-p`` listen flags (always, plus ``-m`` for monitoring), an optional
``-c <config>`` — the repo-level identity fixtures under
:data:`IDENTITY_FIXTURES_DIR` are port-less on purpose; ``-a/-p`` supply the
address, so nothing is templated — and an optional ``-js -sd <tmpdir>`` for
JetStream. stderr is captured next to the log so a config the server
rejects fails fast with the reason in the exception, instead of a bare 5 s
timeout.

This copy (client-sdk) is canonical; ``agent-sdk/python/tests/harness/
nats_server.py`` is byte-identical — keep the two in sync.
"""

from __future__ import annotations

import shutil
import socket
import subprocess
import tempfile
import time
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

#: Repo-level identity fixtures (``test-fixtures/identity/``): throwaway
#: nkeys (``keys.json``), agent-ID parse fixtures, and port-less nats-server
#: configs. Resolved from this file, never from the cwd. Counting up from
#: ``tests/harness/nats_server.py``: ``harness`` → ``tests`` → ``<package>``
#: → ``client-sdk`` (or ``agent-sdk``) → repo root, i.e. ``parents[4]``.
IDENTITY_FIXTURES_DIR = Path(__file__).resolve().parents[4] / "test-fixtures" / "identity"

STARTUP_TIMEOUT_S = 5.0
STDERR_TAIL_LINES = 20


def identity_fixture(name: str) -> Path:
    """Absolute path of a file under :data:`IDENTITY_FIXTURES_DIR`."""
    return IDENTITY_FIXTURES_DIR / name


def find_nats_server() -> str | None:
    """Absolute path to `nats-server`, or None if not installed."""
    return shutil.which("nats-server")


def _pick_free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _pick_free_ports(n: int) -> tuple[int, ...]:
    """Pick *n* distinct free ports atomically.

    Holds all *n* binds simultaneously before closing any, so the
    kernel cannot hand out the same ephemeral port twice across a
    single multi-port allocation. Two back-to-back :func:`_pick_free_port`
    calls would have a vanishingly rare TOCTOU collision when the
    kernel reuses the same port for both — uncommon, but a harness that
    needs distinct ports shouldn't depend on luck. (The window between
    closing the sockets here and nats-server binding them remains; this
    only guarantees the two ports differ from each other.)
    """
    socks = [socket.socket(socket.AF_INET, socket.SOCK_STREAM) for _ in range(n)]
    try:
        for sock in socks:
            sock.bind(("127.0.0.1", 0))
        return tuple(int(sock.getsockname()[1]) for sock in socks)
    finally:
        for sock in socks:
            sock.close()


@dataclass
class RunningServer:
    """A nats-server running as a child process of the test session.

    Exposes both the client port (``url``) and the HTTP monitoring port
    (``monitoring_url``) so tests that want to verify broker-side state
    (e.g. live subscription count) can hit ``/subsz`` directly rather
    than relying on SDK-internal instrumentation.
    """

    url: str
    process: subprocess.Popen[bytes]
    stdout_log: Path
    port: int
    monitoring_port: int
    monitoring_url: str
    #: The server's stderr — a rejected config lands here before ``-l``
    #: logging starts.
    stderr_log: Path
    #: The ``-c`` config file, if any.
    config_path: Path | None = None
    #: The JetStream store dir when started with ``jetstream=True``; removed
    #: by :meth:`stop`.
    store_dir: Path | None = None

    def stderr_tail(self, lines: int = STDERR_TAIL_LINES) -> str:
        """The last *lines* of the server's stderr (empty if none)."""
        try:
            text = self.stderr_log.read_text(errors="replace")
        except OSError:
            return ""
        return "\n".join(text.splitlines()[-lines:])

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        if self.store_dir is not None:
            shutil.rmtree(self.store_dir, ignore_errors=True)


def start_server(
    log_dir: Path, *, config_path: Path | None = None, jetstream: bool = False
) -> RunningServer:
    """Start a fresh nats-server on a free port, logging verbosely to `log_dir`.

    Returns a handle with ``.url`` (nats://127.0.0.1:<client_port>),
    ``.monitoring_url`` (http://127.0.0.1:<monitoring_port>), and a
    ``.stop()`` method. Raises RuntimeError if the server exits before
    listening (the message carries its stderr — the config error) or if
    either port fails to accept connections within 5 seconds.

    ``config_path`` is passed as ``-c``; the ``-a/-p`` flags override any
    listen address in it, so fixture configs stay port-less. ``jetstream``
    adds ``-js -sd <tmpdir>``; the store dir is removed on ``stop()``.

    The monitoring port is enabled unconditionally: it costs one extra
    listening socket and lets tests assert broker-observed truth (e.g.
    subscription counts via ``/subsz``) instead of having to monkey-
    patch SDK internals.
    """
    binary = find_nats_server()
    if binary is None:
        raise RuntimeError("nats-server not on PATH")

    log_dir.mkdir(parents=True, exist_ok=True)
    port, monitoring_port = _pick_free_ports(2)
    log_file = log_dir / f"nats-server-{port}.log"
    stderr_file = log_dir / f"nats-server-{port}.stderr"

    # -DV = debug+verbose; -a = address; -p = client port; -m = HTTP
    # monitoring port. We write to a file so the test can attach it as
    # evidence on failure without racing the subprocess pipe.
    args = [
        binary,
        "-DV",
        "-a",
        "127.0.0.1",
        "-p",
        str(port),
        "-m",
        str(monitoring_port),
        "-l",
        str(log_file),
    ]
    if config_path is not None:
        args += ["-c", str(config_path)]
    store_dir: Path | None = None
    if jetstream:
        store_dir = Path(tempfile.mkdtemp(prefix="synadia-nats-js-"))
        args += ["-js", "-sd", str(store_dir)]

    # Popen dups the descriptor; closing our handle afterwards is fine.
    with stderr_file.open("wb") as stderr_fh:
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=stderr_fh)

    server = RunningServer(
        url=f"nats://127.0.0.1:{port}",
        process=proc,
        stdout_log=log_file,
        port=port,
        monitoring_port=monitoring_port,
        monitoring_url=f"http://127.0.0.1:{monitoring_port}",
        stderr_log=stderr_file,
        config_path=config_path,
        store_dir=store_dir,
    )
    for what, listen_port in (("client", port), ("monitoring", monitoring_port)):
        if not _wait_for_listen(listen_port, timeout=STARTUP_TIMEOUT_S, process=proc):
            server.stop()
            raise RuntimeError(_startup_failure(what, listen_port, args, server))
    return server


def _startup_failure(what: str, port: int, args: list[str], server: RunningServer) -> str:
    code = server.process.poll()
    if code is not None:
        head = f"nats-server exited before listening (code={code})"
    else:
        head = (
            f"nats-server {what} port :{port} did not accept connections "
            f"within {STARTUP_TIMEOUT_S:g}s"
        )
    message = f"{head}; args: {' '.join(args)}; log: {server.stdout_log}"
    tail = server.stderr_tail()
    if tail:
        message += f"\n--- nats-server stderr (tail) ---\n{tail}"
    return message


def _wait_for_listen(
    port: int, *, timeout: float, process: subprocess.Popen[bytes] | None = None
) -> bool:
    """Poll the port until it accepts a TCP connection or the timeout elapses.

    Returns False early when *process* has already exited — a rejected
    config must not cost the full timeout.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            return False
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.settimeout(0.25)
            try:
                sock.connect(("127.0.0.1", port))
                return True
            except OSError:
                time.sleep(0.05)
    return False

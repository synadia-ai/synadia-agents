"""Spawn a local `nats-server` for integration tests.

Skips integration tests cleanly if `nats-server` is not on PATH. We do not
bundle or auto-download the server — it's a Go binary the user installs via
`brew install nats-server` (macOS) or their distro's instructions.
"""

from __future__ import annotations

import shutil
import socket
import subprocess
import time
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path


def find_nats_server() -> str | None:
    """Absolute path to `nats-server`, or None if not installed."""
    return shutil.which("nats-server")


def _pick_free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@dataclass
class RunningServer:
    """A nats-server running as a child process of the test session."""

    url: str
    process: subprocess.Popen[bytes]
    stdout_log: Path
    port: int

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)


def start_server(log_dir: Path) -> RunningServer:
    """Start a fresh nats-server on a free port, logging verbosely to `log_dir`.

    Returns a handle with `.url` (nats://127.0.0.1:<port>) and a `.stop()` method.
    Raises RuntimeError if the server fails to accept connections within 5 seconds.
    """
    binary = find_nats_server()
    if binary is None:
        raise RuntimeError("nats-server not on PATH")

    log_dir.mkdir(parents=True, exist_ok=True)
    port = _pick_free_port()
    log_file = log_dir / f"nats-server-{port}.log"

    # -DV = debug+verbose; -a = address; -p = port. We write to a file so the
    # test can attach it as evidence on failure without racing the subprocess pipe.
    proc = subprocess.Popen(
        [binary, "-DV", "-a", "127.0.0.1", "-p", str(port), "-l", str(log_file)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    url = f"nats://127.0.0.1:{port}"
    if not _wait_for_listen(port, timeout=5.0):
        proc.kill()
        raise RuntimeError(
            f"nats-server failed to accept connections on :{port} within 5s; "
            f"see {log_file} for details"
        )
    return RunningServer(url=url, process=proc, stdout_log=log_file, port=port)


def _wait_for_listen(port: int, *, timeout: float) -> bool:
    """Poll the port until it accepts a TCP connection or the timeout elapses."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.settimeout(0.25)
            try:
                sock.connect(("127.0.0.1", port))
                return True
            except OSError:
                time.sleep(0.05)
    return False

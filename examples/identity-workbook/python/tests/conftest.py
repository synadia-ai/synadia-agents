"""Real-NATS test fixture for the Python identity workbook."""

from __future__ import annotations

import shutil
import socket
import subprocess
import time
from collections.abc import Iterator
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

import pytest

from prepare_nkeys import ProvisionedNkeys, provision

STARTUP_TIMEOUT_S = 5.0


@dataclass(frozen=True, slots=True)
class WorkbookServer:
    url: str
    identities: ProvisionedNkeys


def _free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_server(port: int, process: subprocess.Popen[bytes]) -> bool:
    deadline = time.monotonic() + STARTUP_TIMEOUT_S
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.settimeout(0.25)
            try:
                sock.connect(("127.0.0.1", port))
                return True
            except OSError:
                time.sleep(0.05)
    return False


@pytest.fixture
def workbook_server(tmp_path: Path) -> Iterator[WorkbookServer]:
    binary = shutil.which("nats-server")
    if binary is None:
        pytest.skip("nats-server not on PATH — install it to run the workbook e2e test")

    identities = provision(tmp_path / "identity")
    port = _free_port()
    log_path = tmp_path / "nats-server.log"
    with log_path.open("wb") as log_file:
        process = subprocess.Popen(
            [
                binary,
                "-a",
                "127.0.0.1",
                "-p",
                str(port),
                "-c",
                str(identities.config_path),
            ],
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )

    if not _wait_for_server(port, process):
        process.terminate()
        process.wait(timeout=2)
        details = log_path.read_text(encoding="utf-8", errors="replace")
        raise RuntimeError(f"nats-server failed to start:\n{details}")

    try:
        yield WorkbookServer(url=f"nats://127.0.0.1:{port}", identities=identities)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

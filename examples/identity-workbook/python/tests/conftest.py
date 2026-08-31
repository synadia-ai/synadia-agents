"""Real-NATS test fixture for the Python identity workbook."""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

from prepare_nkeys import ProvisionedNkeys, provision

STARTUP_TIMEOUT_S = 5.0


@dataclass(frozen=True, slots=True)
class WorkbookServer:
    url: str
    identities: ProvisionedNkeys


def _wait_for_server_url(ports_dir: Path, process: subprocess.Popen[bytes]) -> str | None:
    """Read the server-selected ephemeral port after it starts listening."""
    deadline = time.monotonic() + STARTUP_TIMEOUT_S
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return None
        for ports_file in ports_dir.glob("nats-server_*.ports"):
            try:
                payload = json.loads(ports_file.read_text(encoding="utf-8"))
                urls = payload["nats"]
                if isinstance(urls, list) and urls and isinstance(urls[0], str):
                    return urls[0]
            except (json.JSONDecodeError, KeyError, OSError, TypeError):
                pass
        time.sleep(0.05)
    return None


@pytest.fixture
def workbook_server(tmp_path: Path) -> Iterator[WorkbookServer]:
    binary = shutil.which("nats-server")
    if binary is None:
        pytest.skip("nats-server not on PATH — install it to run the workbook e2e test")

    identities = provision(tmp_path / "identity")
    ports_dir = tmp_path / "ports"
    ports_dir.mkdir()
    log_path = tmp_path / "nats-server.log"
    with log_path.open("wb") as log_file:
        process = subprocess.Popen(
            [
                binary,
                "-a",
                "127.0.0.1",
                "-p",
                "-1",
                "--ports_file_dir",
                str(ports_dir),
                "-c",
                str(identities.config_path),
            ],
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )

    url = _wait_for_server_url(ports_dir, process)
    if url is None:
        process.terminate()
        process.wait(timeout=2)
        details = log_path.read_text(encoding="utf-8", errors="replace")
        raise RuntimeError(f"nats-server failed to start:\n{details}")

    try:
        yield WorkbookServer(url=url, identities=identities)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

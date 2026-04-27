"""End-to-end test for ``load_context_options`` against a real broker."""

from __future__ import annotations

import json
from pathlib import Path

import nats
import pytest

from natsagent import load_context_options
from tests.harness.nats_server import RunningServer


async def test_context_options_round_trip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, nats_server: RunningServer
) -> None:
    """A context file pointing at the session's nats-server produces a working conn."""
    monkeypatch.delenv("NATS_CONFIG_HOME", raising=False)
    monkeypatch.delenv("NATS_CONTEXT", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    ctx_dir = tmp_path / "nats" / "context"
    ctx_dir.mkdir(parents=True, exist_ok=True)
    (ctx_dir / "e2e.json").write_text(
        json.dumps({"description": "pytest e2e", "url": nats_server.url}),
        encoding="utf-8",
    )

    nc = await nats.connect(**load_context_options("e2e"))
    try:
        # Prove the conn is actually usable: subscribe, publish, receive.
        sub = await nc.subscribe("ctx.probe")
        await nc.publish("ctx.probe", b"ping")
        msg = await sub.next_msg(timeout=2.0)
        assert msg.data == b"ping"
        await sub.unsubscribe()
    finally:
        await nc.close()

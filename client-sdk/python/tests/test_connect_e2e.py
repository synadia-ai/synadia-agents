"""End-to-end tests for ``natsagent.connect``: real broker, context + passthrough."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

import natsagent
from tests.harness.nats_server import RunningServer

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


async def test_connect_via_context_round_trips(
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

    nc = await natsagent.connect(context="e2e")
    try:
        # Prove the conn is actually usable: subscribe, publish, receive.
        sub = await nc.subscribe("ctx.probe")
        await nc.publish("ctx.probe", b"ping")
        msg = await sub.next_msg(timeout=2.0)
        assert msg.data == b"ping"
        await sub.unsubscribe()
    finally:
        await nc.close()


async def test_connect_nc_passthrough_returns_same_instance(nc: NATSClient) -> None:
    """``connect(nc=existing)`` hands back the same object, no reconnect."""
    returned = await natsagent.connect(nc=nc)
    assert returned is nc

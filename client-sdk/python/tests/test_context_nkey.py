"""``nkey`` contexts: ``nkeys_seed=<path>``, ``~`` expansion, precedence, and a live connect."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

import nats
import pytest

from synadia_ai.agents import Agents, NatsContextError, load_context_options, read_context_file

if TYPE_CHECKING:
    from tests.conftest import NkeyUser
    from tests.harness.nats_server import RunningServer


def _point_env_at(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.delenv("NATS_CONFIG_HOME", raising=False)
    monkeypatch.delenv("NATS_CONTEXT", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir(exist_ok=True)
    base = tmp_path / "nats"
    (base / "context").mkdir(parents=True, exist_ok=True)
    return base


def _write(base: Path, name: str, body: dict[str, Any]) -> Path:
    path = base / "context" / f"{name}.json"
    path.write_text(json.dumps(body), encoding="utf-8")
    return path


def test_nkey_maps_to_nkeys_seed_str(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The seed line is read and trimmed: nats-py's `nkeys_seed=<path>` would choke on `\\n`."""
    base = _point_env_at(tmp_path, monkeypatch)
    seed = tmp_path / "home" / "user.nk"
    seed.write_text("SUATESTSEED\n", encoding="utf-8")
    _write(base, "nk", {"url": "nats://127.0.0.1:4222", "nkey": str(seed)})
    assert load_context_options("nk") == {
        "servers": ["nats://127.0.0.1:4222"],
        "nkeys_seed_str": "SUATESTSEED",
    }
    _write(base, "tilde", {"url": "nats://127.0.0.1:4222", "nkey": "~/user.nk"})
    assert load_context_options("tilde")["nkeys_seed_str"] == "SUATESTSEED"
    block = tmp_path / "home" / "block.nk"
    block.write_text(
        "-----BEGIN USER NKEY SEED-----\nSUABLOCKSEED\n------END USER NKEY SEED------\n",
        encoding="utf-8",
    )
    _write(base, "block", {"url": "nats://127.0.0.1:4222", "nkey": str(block)})
    assert load_context_options("block")["nkeys_seed_str"] == "SUABLOCKSEED"
    empty = tmp_path / "home" / "empty.nk"
    empty.write_text("\n", encoding="utf-8")
    _write(base, "empty", {"url": "nats://127.0.0.1:4222", "nkey": str(empty)})
    with pytest.raises(NatsContextError, match="no nkey seed line"):
        load_context_options("empty")


def test_nkey_missing_file_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write(base, "nk", {"url": "nats://127.0.0.1:4222", "nkey": str(tmp_path / "nope.nk")})
    with pytest.raises(NatsContextError, match="nkey seed file not found"):
        load_context_options("nk")


def test_auth_precedence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    creds = tmp_path / "home" / "x.creds"
    creds.write_text("...", encoding="utf-8")
    seed = tmp_path / "home" / "x.nk"
    seed.write_text("SUASEED\n", encoding="utf-8")
    everything = {
        "url": "nats://127.0.0.1:4222",
        "creds": str(creds),
        "nkey": str(seed),
        "user_jwt": "ey.x.y",
        "user": "u",
        "password": "p",
        "token": "t",
    }
    _write(base, "all", everything)
    assert set(load_context_options("all")) == {"servers", "user_credentials"}
    _write(base, "no-creds", {k: v for k, v in everything.items() if k != "creds"})
    assert set(load_context_options("no-creds")) == {"servers", "nkeys_seed_str"}
    _write(base, "jwt", {k: v for k, v in everything.items() if k not in ("creds", "nkey")})
    assert set(load_context_options("jwt")) == {"servers", "user_jwt_cb"}
    _write(base, "userpass", {"url": "nats://x:4222", "user": "u", "password": "p", "token": "t"})
    assert load_context_options("userpass") == {
        "servers": ["nats://x:4222"],
        "user": "u",
        "password": "p",
    }
    _write(base, "token", {"url": "nats://x:4222", "token": "t"})
    assert load_context_options("token") == {"servers": ["nats://x:4222"], "token": "t"}


def test_read_context_file_is_the_reading_half(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    path = _write(base, "raw", {"url": "nats://x:4222", "nkey": "/nowhere", "extra": 1})
    ctx = read_context_file("raw")
    assert ctx.name == "raw" and ctx.path == path
    assert ctx.fields == {
        "url": "nats://x:4222",
        "nkey": "/nowhere",
        "extra": 1,
    }  # no validation here
    with pytest.raises(NatsContextError):
        read_context_file("ghost")


async def test_nkey_context_connects_and_yields_an_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    nats_server_nkey: RunningServer,
    identity_keys: dict[str, NkeyUser],
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    seed = tmp_path / "home" / "alice.nk"
    seed.write_text(identity_keys["alice"].seed + "\n", encoding="utf-8")
    _write(base, "alice", {"url": nats_server_nkey.url, "nkey": "~/alice.nk"})
    nc = await nats.connect(**load_context_options("alice"))
    try:
        agents = Agents(nc=nc)
        assert await agents.self_id() == f"$G.{identity_keys['alice'].public}"
        await agents.close()
    finally:
        await nc.close()

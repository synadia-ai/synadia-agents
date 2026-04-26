"""Unit tests for ``natsagent.connect`` and its NATS-context resolver.

Pure-functional: no live NATS, no real ``~/.config/nats``. Each test
redirects the resolver's view of the config dir via ``monkeypatch`` so
the user's own contexts are never touched.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path
from typing import Any

import pytest

import natsagent
from natsagent import (
    ContextInvalidError,
    ContextNotFoundError,
    ContextNotSelectedError,
    ContextNotSupportedError,
)
from natsagent.connect import (
    _assert_valid_context_name,
    _build_connection_kwargs,
    _load_context,
    _resolve_current_context_name,
    _split_urls,
)

# `natsagent.connect` (function) shadows `natsagent.connect` (module) in the
# package namespace because __init__.py re-exports the function under the
# same name. Grab the underlying module via importlib so we can monkeypatch
# its `nats.connect` reference without relying on attribute lookup.
connect_module = importlib.import_module("natsagent.connect")


def _point_env_at(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect the resolver's config root at ``tmp_path/nats`` via XDG."""
    # Strip every env var that would override XDG so the lookup is deterministic.
    monkeypatch.delenv("NATS_CONFIG_HOME", raising=False)
    monkeypatch.delenv("NATS_CONTEXT", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    # Give HOME a stable value so the ~-expansion tests are predictable.
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    base = tmp_path / "nats"
    (base / "context").mkdir(parents=True, exist_ok=True)
    return base


def _write_context(base: Path, name: str, body: dict[str, Any]) -> Path:
    path = base / "context" / f"{name}.json"
    path.write_text(json.dumps(body), encoding="utf-8")
    return path


def test_resolve_current_from_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _point_env_at(tmp_path, monkeypatch)
    monkeypatch.setenv("NATS_CONTEXT", "staging")
    assert _resolve_current_context_name() == "staging"


def test_resolve_current_from_pointer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    (base / "context.txt").write_text("prod\n", encoding="utf-8")
    assert _resolve_current_context_name() == "prod"


def test_resolve_current_missing_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _point_env_at(tmp_path, monkeypatch)
    with pytest.raises(ContextNotSelectedError) as exc_info:
        _resolve_current_context_name()
    assert "context.txt" in str(exc_info.value)


def test_load_context_happy_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(
        base,
        "dev",
        {
            "description": "local dev",
            "url": "nats://127.0.0.1:4222",
            "inbox_prefix": "_MY_INBOX",
        },
    )
    ctx = _load_context("dev")
    assert ctx.name == "dev"
    assert ctx.servers == ["nats://127.0.0.1:4222"]
    assert ctx.description == "local dev"
    assert ctx.connection_kwargs["inbox_prefix"] == b"_MY_INBOX"


def test_load_context_missing_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _point_env_at(tmp_path, monkeypatch)
    with pytest.raises(ContextNotFoundError) as exc_info:
        _load_context("ghost")
    message = str(exc_info.value)
    assert "ghost" in message
    assert "nats context ls" in message


def test_load_context_malformed_json_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    (base / "context" / "bad.json").write_text("not-json", encoding="utf-8")
    with pytest.raises(ContextInvalidError) as exc_info:
        _load_context("bad")
    assert "not valid JSON" in str(exc_info.value)


@pytest.mark.parametrize(
    "bad_name",
    [
        "",
        "..",
        "../escape",
        "a/b",
        "a\\b",
        ".hidden",
        "a\x00b",
        "\x00",
        "ok\x00..",
    ],
)
def test_context_name_validation(bad_name: str) -> None:
    with pytest.raises(ContextInvalidError):
        _assert_valid_context_name(bad_name)


def test_split_urls_comma_separated() -> None:
    assert _split_urls("a,b , ,c") == ["a", "b", "c"]
    assert _split_urls("") == []
    assert _split_urls("solo") == ["solo"]


def test_field_mapping_full_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """``creds`` supersedes user/pass/token; inbox_prefix survives."""
    base = _point_env_at(tmp_path, monkeypatch)
    creds_path = tmp_path / "nats.creds"
    creds_path.write_text("-----BEGIN NATS USER JWT-----\n...\n", encoding="utf-8")
    _write_context(
        base,
        "full",
        {
            "url": "nats://a:4222,nats://b:4222",
            "creds": str(creds_path),
            "user": "ignored",
            "password": "ignored",
            "token": "ignored",
            "inbox_prefix": "_X",
        },
    )
    ctx = _load_context("full")
    assert ctx.servers == ["nats://a:4222", "nats://b:4222"]
    kw = ctx.connection_kwargs
    assert kw["user_credentials"] == str(creds_path)
    assert "user" not in kw
    assert "password" not in kw
    assert "token" not in kw
    assert kw["inbox_prefix"] == b"_X"


def test_field_mapping_empty_strings_treated_as_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(
        base,
        "empty",
        {
            "url": "nats://127.0.0.1:4222",
            "token": "",
            "user": "",
            "password": "",
            "inbox_prefix": "",
        },
    )
    ctx = _load_context("empty")
    assert ctx.connection_kwargs == {}


def test_field_mapping_user_jwt_authenticator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(
        base,
        "jwt",
        {"url": "nats://127.0.0.1:4222", "user_jwt": "ey.token"},
    )
    ctx = _load_context("jwt")
    cb = ctx.connection_kwargs["user_jwt_cb"]
    assert callable(cb)
    assert cb() == b"ey.token"
    assert "token" not in ctx.connection_kwargs


def test_field_mapping_creds_missing_file_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(
        base,
        "nofile",
        {"url": "nats://127.0.0.1:4222", "creds": str(tmp_path / "nope.creds")},
    )
    with pytest.raises(ContextInvalidError) as exc_info:
        _load_context("nofile")
    assert "creds file not found" in str(exc_info.value)


def test_field_mapping_creds_tilde_expansion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    home = Path(tmp_path / "home")
    (home / ".nats").mkdir(parents=True, exist_ok=True)
    creds_abs = home / ".nats" / "cloud.creds"
    creds_abs.write_text("...", encoding="utf-8")

    _build_kwargs = _build_connection_kwargs  # alias so pylint-style formatting is kind
    kw = _build_kwargs(
        "ctx",
        {"url": "nats://", "creds": "~/.nats/cloud.creds"},
    )
    assert kw["user_credentials"] == str(creds_abs)

    _write_context(
        base,
        "tilde",
        {"url": "nats://127.0.0.1:4222", "creds": "~/.nats/cloud.creds"},
    )
    ctx = _load_context("tilde")
    assert ctx.connection_kwargs["user_credentials"] == str(creds_abs)


def test_unsupported_nkey_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(base, "nk", {"url": "nats://127.0.0.1:4222", "nkey": "SUA..."})
    with pytest.raises(ContextNotSupportedError) as exc_info:
        _load_context("nk")
    assert exc_info.value.field == "nkey"


def test_unsupported_tls_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(
        base,
        "tls",
        {"url": "nats://127.0.0.1:4222", "cert": "/tmp/c.pem"},
    )
    with pytest.raises(ContextNotSupportedError) as exc_info:
        _load_context("tls")
    assert exc_info.value.field == "cert"


def test_unsupported_nsc_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(base, "nsc", {"url": "nsc://operator/account/user"})
    with pytest.raises(ContextNotSupportedError) as exc_info:
        _load_context("nsc")
    assert exc_info.value.field == "nsc"


async def test_connect_nc_exclusive_with_servers() -> None:
    sentinel: Any = object()
    with pytest.raises(ValueError, match="exclusive"):
        await natsagent.connect(nc=sentinel, servers="nats://a")


async def test_connect_nc_exclusive_with_extras() -> None:
    sentinel: Any = object()
    with pytest.raises(ValueError, match="exclusive"):
        await natsagent.connect(nc=sentinel, max_reconnect_attempts=1)


async def test_connect_no_source_raises() -> None:
    with pytest.raises(ValueError, match="one of"):
        await natsagent.connect()


async def test_connect_servers_override_context_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Explicit ``servers=`` overrides the context's ``url`` field."""
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(base, "ctx", {"url": "nats://from-context:4222"})

    captured: dict[str, Any] = {}

    async def fake_connect(servers: Any, **kwargs: Any) -> Any:
        captured["servers"] = servers
        captured["kwargs"] = kwargs
        return object()

    monkeypatch.setattr(connect_module.nats, "connect", fake_connect)
    await natsagent.connect(servers="nats://override:4222", context="ctx")
    assert captured["servers"] == "nats://override:4222"


async def test_connect_nats_kwargs_merge_over_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Caller-supplied kwargs shallow-merge OVER context-derived ones."""
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(
        base,
        "merge",
        {
            "url": "nats://127.0.0.1:4222",
            "inbox_prefix": "_FROM_CTX",
            "token": "ctx-token",
        },
    )

    captured: dict[str, Any] = {}

    async def fake_connect(servers: Any, **kwargs: Any) -> Any:
        captured["servers"] = servers
        captured["kwargs"] = kwargs
        return object()

    monkeypatch.setattr(connect_module.nats, "connect", fake_connect)
    await natsagent.connect(context="merge", token="override-token")
    assert captured["servers"] == ["nats://127.0.0.1:4222"]
    # inbox_prefix came from context, token got overridden.
    assert captured["kwargs"]["inbox_prefix"] == b"_FROM_CTX"
    assert captured["kwargs"]["token"] == "override-token"


async def test_connect_current_honours_env_over_selection_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    (base / "context.txt").write_text("file-ctx", encoding="utf-8")
    _write_context(base, "env-ctx", {"url": "nats://env:4222"})
    _write_context(base, "file-ctx", {"url": "nats://file:4222"})
    monkeypatch.setenv("NATS_CONTEXT", "env-ctx")

    captured: dict[str, Any] = {}

    async def fake_connect(servers: Any, **kwargs: Any) -> Any:
        captured["servers"] = servers
        return object()

    monkeypatch.setattr(connect_module.nats, "connect", fake_connect)
    await natsagent.connect(context=True)
    assert captured["servers"] == ["nats://env:4222"]

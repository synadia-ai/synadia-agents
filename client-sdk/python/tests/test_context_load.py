"""Unit tests for ``synadia_ai.agents.load_context_options``.

Pure-functional: no live NATS, no real ``~/.config/nats``. Each test
redirects the resolver's view of the config dir via ``monkeypatch`` so
the user's own contexts are never touched.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from synadia_ai.agents import NatsContextError, load_context_options


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
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(base, "staging", {"url": "nats://staging:4222"})
    monkeypatch.setenv("NATS_CONTEXT", "staging")
    opts = load_context_options("current")
    assert opts["servers"] == ["nats://staging:4222"]


def test_resolve_current_from_pointer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(base, "prod", {"url": "nats://prod:4222"})
    (base / "context.txt").write_text("prod\n", encoding="utf-8")
    opts = load_context_options("current")
    assert opts["servers"] == ["nats://prod:4222"]


def test_resolve_current_missing_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _point_env_at(tmp_path, monkeypatch)
    with pytest.raises(NatsContextError) as exc_info:
        load_context_options("current")
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
    opts = load_context_options("dev")
    assert opts["servers"] == ["nats://127.0.0.1:4222"]
    assert opts["inbox_prefix"] == "_MY_INBOX"


def test_load_context_missing_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _point_env_at(tmp_path, monkeypatch)
    with pytest.raises(NatsContextError) as exc_info:
        load_context_options("ghost")
    message = str(exc_info.value)
    assert "ghost" in message
    assert "nats context ls" in message


def test_load_context_malformed_json_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    (base / "context" / "bad.json").write_text("not-json", encoding="utf-8")
    with pytest.raises(NatsContextError) as exc_info:
        load_context_options("bad")
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
def test_context_name_validation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad_name: str
) -> None:
    _point_env_at(tmp_path, monkeypatch)
    with pytest.raises(NatsContextError):
        load_context_options(bad_name)


def test_split_urls_comma_separated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(base, "multi", {"url": "nats://a:4222,nats://b:4222 , ,nats://c:4222"})
    opts = load_context_options("multi")
    assert opts["servers"] == ["nats://a:4222", "nats://b:4222", "nats://c:4222"]


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
    opts = load_context_options("full")
    assert opts["servers"] == ["nats://a:4222", "nats://b:4222"]
    assert opts["user_credentials"] == str(creds_path)
    assert "user" not in opts
    assert "password" not in opts
    assert "token" not in opts
    assert opts["inbox_prefix"] == "_X"


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
    opts = load_context_options("empty")
    assert opts == {"servers": ["nats://127.0.0.1:4222"]}


def test_field_mapping_user_jwt_authenticator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(
        base,
        "jwt",
        {"url": "nats://127.0.0.1:4222", "user_jwt": "ey.token"},
    )
    opts = load_context_options("jwt")
    cb = opts["user_jwt_cb"]
    assert callable(cb)
    assert cb() == b"ey.token"
    assert "token" not in opts


def test_field_mapping_creds_missing_file_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(
        base,
        "nofile",
        {"url": "nats://127.0.0.1:4222", "creds": str(tmp_path / "nope.creds")},
    )
    with pytest.raises(NatsContextError) as exc_info:
        load_context_options("nofile")
    assert "creds file not found" in str(exc_info.value)


def test_field_mapping_creds_tilde_expansion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    home = Path(tmp_path / "home")
    (home / ".nats").mkdir(parents=True, exist_ok=True)
    creds_abs = home / ".nats" / "cloud.creds"
    creds_abs.write_text("...", encoding="utf-8")

    _write_context(
        base,
        "tilde",
        {"url": "nats://127.0.0.1:4222", "creds": "~/.nats/cloud.creds"},
    )
    opts = load_context_options("tilde")
    assert opts["user_credentials"] == str(creds_abs)


def test_unsupported_nkey_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(base, "nk", {"url": "nats://127.0.0.1:4222", "nkey": "SUA..."})
    with pytest.raises(NatsContextError) as exc_info:
        load_context_options("nk")
    assert "nkey" in str(exc_info.value)


def test_unsupported_tls_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(
        base,
        "tls",
        {"url": "nats://127.0.0.1:4222", "cert": "/tmp/c.pem"},
    )
    with pytest.raises(NatsContextError) as exc_info:
        load_context_options("tls")
    assert "cert" in str(exc_info.value)


def test_unsupported_nsc_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(base, "nsc", {"url": "nsc://operator/account/user"})
    with pytest.raises(NatsContextError) as exc_info:
        load_context_options("nsc")
    assert "nsc" in str(exc_info.value)


def test_user_jwt_only_context_produces_authenticated_kwargs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A `user_jwt`-only context wires `user_jwt_cb` and excludes fallback auth.

    Regression guard against the TS SDK's PR #10 bug, where the example
    context loaders silently dropped ``user_jwt`` and produced an
    unauthenticated connection that failed deep in the broker handshake
    with no useful error.
    """
    base = _point_env_at(tmp_path, monkeypatch)
    _write_context(
        base,
        "jwt-only",
        {"url": "nats://127.0.0.1:4222", "user_jwt": "ey.header.payload"},
    )
    opts = load_context_options("jwt-only")
    assert "user_jwt_cb" in opts
    assert callable(opts["user_jwt_cb"])
    assert opts["user_jwt_cb"]() == b"ey.header.payload"
    for k in ("user_credentials", "token", "user", "password"):
        assert k not in opts, f"unexpected fallback auth field {k!r} in {opts!r}"


def test_current_honours_env_over_selection_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = _point_env_at(tmp_path, monkeypatch)
    (base / "context.txt").write_text("file-ctx", encoding="utf-8")
    _write_context(base, "env-ctx", {"url": "nats://env:4222"})
    _write_context(base, "file-ctx", {"url": "nats://file:4222"})
    monkeypatch.setenv("NATS_CONTEXT", "env-ctx")

    opts = load_context_options("current")
    assert opts["servers"] == ["nats://env:4222"]

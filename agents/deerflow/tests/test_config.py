from __future__ import annotations

from pathlib import Path
from typing import Any

from synadia_ai.nats_deerflow_channel.config import resolve_config

# Every identity env var the resolver reads, so a developer's shell can't leak
# into the default-state and precedence tests.
_IDENTITY_ENV_VARS = (
    "SYNADIA_DEERFLOW_OWNER",
    "SYNADIA_OWNER",
    "NATS_OWNER",
    "DEERFLOW_NATS_OWNER",
    "SYNADIA_DEERFLOW_NAME",
    "SYNADIA_NAME",
    "NATS_AGENT_NAME",
    "NATS_SESSION",
)


def test_defaults_include_df_agent(tmp_path: Path, monkeypatch: Any) -> None:
    for name in _IDENTITY_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("DEERFLOW_URL", raising=False)

    config = resolve_config(config_file=tmp_path / "missing.toml")

    assert config.agent == "df"
    assert config.session == "default"
    assert config.deerflow_url == "http://localhost:2026"
    assert config.deerflow_timeout_s == 60.0
    assert config.query_timeout_s == 300.0
    assert config.max_payload is None
    assert config.redacted_dict()["prompt_subject"] == "agents.prompt.df.<owner>.default"


def test_config_file_then_env_then_cli_precedence(tmp_path: Path, monkeypatch: Any) -> None:
    config_file = tmp_path / "config.toml"
    config_file.write_text(
        "\n".join(
            [
                'agent = "from-file"',
                'owner = "file-owner"',
                'session = "file-session"',
                'deerflow_url = "http://file.example"',
                'nats_context = "file-context"',
                "deerflow_timeout_s = 12.5",
                "query_timeout_s = 45",
                'max_payload = "256KB"',
                'deerflow_cookie = "access_token=file; csrf_token=file-csrf"',
                'deerflow_csrf_token = "file-csrf"',
                'deerflow_username = "file@example.com"',
                'deerflow_password = "file-password"',
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("NATS_OWNER", "env-owner")
    monkeypatch.setenv("NATS_AGENT_NAME", "env-session")
    monkeypatch.setenv("DEERFLOW_URL", "http://env.example")
    monkeypatch.setenv("DEERFLOW_TIMEOUT_S", "20")
    monkeypatch.setenv("DEERFLOW_QUERY_TIMEOUT_S", "90")
    monkeypatch.setenv("DEERFLOW_COOKIE", "access_token=env; csrf_token=env-csrf")
    monkeypatch.setenv("DEERFLOW_CSRF_TOKEN", "env-csrf")
    monkeypatch.setenv("DEERFLOW_USERNAME", "env@example.com")
    monkeypatch.setenv("DEERFLOW_PASSWORD", "env-password")

    config = resolve_config(
        config_file=config_file,
        owner="cli-owner",
        deerflow_url="http://cli.example",
        max_payload="512KB",
        deerflow_cookie="access_token=cli; csrf_token=cli-csrf",
        deerflow_csrf_token="cli-csrf",
        deerflow_username="cli@example.com",
        deerflow_password="cli-password",
    )

    assert config.agent == "from-file"
    assert config.owner == "cli-owner"
    assert config.session == "env-session"
    assert config.deerflow_url == "http://cli.example"
    assert config.nats_context == "file-context"
    assert config.deerflow_timeout_s == 20
    assert config.query_timeout_s == 90
    assert config.max_payload == "512KB"
    assert config.deerflow_cookie == "access_token=cli; csrf_token=cli-csrf"
    assert config.deerflow_csrf_token == "cli-csrf"
    assert config.redacted_dict()["deerflow_cookie"] == "[REDACTED]"
    assert config.redacted_dict()["deerflow_csrf_token"] == "[REDACTED]"
    assert config.deerflow_username == "cli@example.com"
    assert config.deerflow_password == "cli-password"
    assert config.redacted_dict()["deerflow_username"] == "cli@example.com"
    assert config.redacted_dict()["deerflow_password"] == "[REDACTED]"


def test_synadia_identity_env_precedence(tmp_path: Path, monkeypatch: Any) -> None:
    """SYNADIA_DEERFLOW_* > SYNADIA_* > legacy aliases > config, and CLI beats all."""
    config_file = tmp_path / "config.toml"
    config_file.write_text(
        'owner = "file-owner"\nsession = "file-session"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("SYNADIA_DEERFLOW_OWNER", "synadia-deerflow-owner")
    monkeypatch.setenv("SYNADIA_OWNER", "synadia-owner")
    monkeypatch.setenv("NATS_OWNER", "nats-owner")
    monkeypatch.setenv("DEERFLOW_NATS_OWNER", "deerflow-nats-owner")
    monkeypatch.setenv("SYNADIA_DEERFLOW_NAME", "synadia-deerflow-name")
    monkeypatch.setenv("SYNADIA_NAME", "synadia-name")
    monkeypatch.setenv("NATS_AGENT_NAME", "nats-agent-name")
    monkeypatch.setenv("NATS_SESSION", "nats-session")

    # Top of each ladder: the per-agent SYNADIA_DEERFLOW_* var wins.
    config = resolve_config(config_file=config_file)
    assert config.owner == "synadia-deerflow-owner"
    assert config.session == "synadia-deerflow-name"

    # A CLI flag still overrides the SYNADIA_* env vars.
    config = resolve_config(config_file=config_file, owner="cli-owner", session="cli-session")
    assert config.owner == "cli-owner"
    assert config.session == "cli-session"

    # Drop the per-agent vars: the fleet-wide SYNADIA_* vars win over legacy.
    monkeypatch.delenv("SYNADIA_DEERFLOW_OWNER")
    monkeypatch.delenv("SYNADIA_DEERFLOW_NAME")
    config = resolve_config(config_file=config_file)
    assert config.owner == "synadia-owner"
    assert config.session == "synadia-name"

    # Drop the fleet-wide vars too: the legacy aliases win over the config file.
    monkeypatch.delenv("SYNADIA_OWNER")
    monkeypatch.delenv("SYNADIA_NAME")
    config = resolve_config(config_file=config_file)
    assert config.owner == "nats-owner"
    assert config.session == "nats-agent-name"

    # Drop the preferred legacy aliases: the secondary aliases win, then config.
    monkeypatch.delenv("NATS_OWNER")
    monkeypatch.delenv("NATS_AGENT_NAME")
    config = resolve_config(config_file=config_file)
    assert config.owner == "deerflow-nats-owner"
    assert config.session == "nats-session"


def test_nats_url_env_is_used(tmp_path: Path, monkeypatch: Any) -> None:
    monkeypatch.setenv("NATS_URL", "nats://127.0.0.1:4222")

    config = resolve_config(config_file=tmp_path / "missing.toml")

    assert config.nats_url == "nats://127.0.0.1:4222"

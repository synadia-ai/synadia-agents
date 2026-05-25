from __future__ import annotations

from pathlib import Path
from typing import Any

from synadia_ai.nats_deerflow_channel.config import resolve_config


def test_defaults_include_df_agent(tmp_path: Path, monkeypatch: Any) -> None:
    monkeypatch.delenv("NATS_OWNER", raising=False)
    monkeypatch.delenv("NATS_AGENT_NAME", raising=False)
    monkeypatch.delenv("DEERFLOW_URL", raising=False)

    config = resolve_config(config_file=tmp_path / "missing.toml")

    assert config.agent == "df"
    assert config.session == "default"
    assert config.deerflow_url == "http://localhost:2026"
    assert config.redacted_dict()["prompt_subject"] == "agents.prompt.df.<owner>.default"


def test_config_file_then_env_then_cli_precedence(tmp_path: Path, monkeypatch: Any) -> None:
    config_file = tmp_path / "config.toml"
    config_file.write_text(
        '\n'.join(
            [
                'agent = "from-file"',
                'owner = "file-owner"',
                'session = "file-session"',
                'deerflow_url = "http://file.example"',
                'nats_context = "file-context"',
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("NATS_OWNER", "env-owner")
    monkeypatch.setenv("NATS_AGENT_NAME", "env-session")
    monkeypatch.setenv("DEERFLOW_URL", "http://env.example")

    config = resolve_config(
        config_file=config_file,
        owner="cli-owner",
        deerflow_url="http://cli.example",
    )

    assert config.agent == "from-file"
    assert config.owner == "cli-owner"
    assert config.session == "env-session"
    assert config.deerflow_url == "http://cli.example"
    assert config.nats_context == "file-context"


def test_nats_url_env_is_used(tmp_path: Path, monkeypatch: Any) -> None:
    monkeypatch.setenv("NATS_URL", "nats://127.0.0.1:4222")

    config = resolve_config(config_file=tmp_path / "missing.toml")

    assert config.nats_url == "nats://127.0.0.1:4222"

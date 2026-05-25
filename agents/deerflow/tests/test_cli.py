from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from synadia_ai.nats_deerflow_channel.cli import main


def test_doctor_success_with_cli_args(capsys: Any) -> None:
    code = main(
        [
            "doctor",
            "--owner",
            "rene",
            "--session",
            "deerflow",
            "--nats-url",
            "nats://127.0.0.1:4222",
        ]
    )

    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["config"]["prompt_subject"] == "agents.prompt.df.rene.deerflow"


def test_doctor_fails_without_owner_or_nats_target(
    capsys: Any, tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.delenv("NATS_OWNER", raising=False)
    monkeypatch.delenv("NATS_URL", raising=False)
    monkeypatch.delenv("NATS_CONTEXT", raising=False)

    code = main(["doctor", "--config-file", str(tmp_path / "missing.toml")])

    assert code == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["checks"]["owner_configured"] is False
    assert payload["checks"]["nats_target_configured"] is False


def test_configure_prints_config_path(capsys: Any, tmp_path: Path) -> None:
    code = main(["configure", "--config-file", str(tmp_path / "config.toml")])

    assert code == 0
    assert capsys.readouterr().out.strip() == str(tmp_path / "config.toml")

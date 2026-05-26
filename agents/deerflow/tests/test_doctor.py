from __future__ import annotations

from typing import Any

import httpx

from synadia_ai.nats_deerflow_channel.config import ChannelConfig
from synadia_ai.nats_deerflow_channel.doctor import run_doctor


def test_doctor_reports_deerflow_reachable_when_health_is_2xx() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/health"
        return httpx.Response(200, json={"status": "healthy"})

    report = run_doctor(
        ChannelConfig(
            owner="rene", nats_url="nats://127.0.0.1:4222", deerflow_url="http://deerflow.test"
        ),
        transport=httpx.MockTransport(handler),
    )

    assert report.ok is True
    assert report.checks["deerflow_reachable"] is True


def test_doctor_accepts_valid_current_nats_context(tmp_path: Any, monkeypatch: Any) -> None:
    nats_home = tmp_path / "nats"
    context_dir = nats_home / "context"
    context_dir.mkdir(parents=True)
    (nats_home / "context.txt").write_text("prod", encoding="utf-8")
    (context_dir / "prod.json").write_text(
        '{"url":"nats://127.0.0.1:4222"}',
        encoding="utf-8",
    )
    monkeypatch.setenv("NATS_CONFIG_HOME", str(nats_home))

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/health"
        return httpx.Response(200, json={"status": "healthy"})

    report = run_doctor(
        ChannelConfig(owner="rene", deerflow_url="http://deerflow.test"),
        transport=httpx.MockTransport(handler),
    )

    assert report.ok is True
    assert report.checks["nats_target_configured"] is False
    assert report.checks["nats_target_valid"] is True


def test_doctor_rejects_invalid_nats_url() -> None:
    report = run_doctor(
        ChannelConfig(
            owner="rene",
            nats_url="not a nats url",
            deerflow_url="http://deerflow.test",
        ),
        transport=httpx.MockTransport(lambda request: httpx.Response(200)),
    )

    assert report.ok is False
    assert report.checks["nats_target_valid"] is False
    assert any(message.startswith("NATS_URL is invalid:") for message in report.messages)


def test_doctor_reports_deerflow_unreachable_without_blocking_config_checks() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="starting")

    report = run_doctor(
        ChannelConfig(
            owner="rene", nats_url="nats://127.0.0.1:4222", deerflow_url="http://deerflow.test"
        ),
        transport=httpx.MockTransport(handler),
    )

    assert report.ok is True
    assert report.checks["deerflow_reachable"] is False
    assert "DeerFlow Gateway is not reachable at http://deerflow.test/health" in report.messages

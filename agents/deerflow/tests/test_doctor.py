from __future__ import annotations

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

"""Doctor checks for the DeerFlow NATS channel."""

from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import httpx

from .config import ChannelConfig

HTTP_OK_MIN = 200
HTTP_OK_MAX = 300


@dataclass(frozen=True)
class DoctorReport:
    ok: bool
    checks: dict[str, bool]
    config: dict[str, str | None]
    messages: list[str]

    def to_json(self) -> str:
        return json.dumps(
            {
                "ok": self.ok,
                "checks": self.checks,
                "config": self.config,
                "messages": self.messages,
            },
            indent=2,
            sort_keys=True,
        )


def _health_url(config: ChannelConfig) -> str:
    return urljoin(config.deerflow_url.rstrip("/") + "/", "health")


def _check_deerflow_reachable(
    config: ChannelConfig,
    *,
    transport: httpx.BaseTransport | None = None,
    timeout: float = 2.0,
) -> bool:
    try:
        with httpx.Client(transport=transport, timeout=timeout) as client:
            response = client.get(_health_url(config))
    except httpx.HTTPError:
        return False
    return HTTP_OK_MIN <= response.status_code < HTTP_OK_MAX


def run_doctor(
    config: ChannelConfig,
    *,
    transport: httpx.BaseTransport | None = None,
) -> DoctorReport:
    """Run shallow checks, including DeerFlow Gateway health reachability."""
    checks: dict[str, bool] = {}
    messages: list[str] = []

    checks["owner_configured"] = bool(config.owner)
    if not config.owner:
        messages.append("owner is not configured; set NATS_OWNER or pass --owner")

    parsed = urlparse(config.deerflow_url)
    checks["deerflow_url_shape"] = parsed.scheme in {"http", "https"} and bool(parsed.netloc)
    if not checks["deerflow_url_shape"]:
        messages.append("deerflow_url must be an http(s) URL")

    checks["nats_target_configured"] = bool(config.nats_context or config.nats_url)
    if not checks["nats_target_configured"]:
        messages.append("set NATS_CONTEXT or NATS_URL before starting the channel")

    checks["agent_token_shape"] = (
        config.agent.replace("-", "").isalnum() and config.agent.lower() == config.agent
    )
    if not checks["agent_token_shape"]:
        messages.append("agent token must be lowercase alphanumeric plus hyphen")

    checks["deerflow_reachable"] = False
    if checks["deerflow_url_shape"]:
        checks["deerflow_reachable"] = _check_deerflow_reachable(config, transport=transport)
        if not checks["deerflow_reachable"]:
            messages.append(f"DeerFlow Gateway is not reachable at {_health_url(config)}")

    ok = all(
        checks[name]
        for name in (
            "owner_configured",
            "deerflow_url_shape",
            "nats_target_configured",
            "agent_token_shape",
        )
    )
    return DoctorReport(ok=ok, checks=checks, config=config.redacted_dict(), messages=messages)

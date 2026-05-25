"""Doctor checks for the DeerFlow NATS channel."""

from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.parse import urlparse

from .config import ChannelConfig


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


def run_doctor(config: ChannelConfig) -> DoctorReport:
    """Run shallow Phase 1 checks without opening network connections."""
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

    ok = all(checks.values())
    return DoctorReport(ok=ok, checks=checks, config=config.redacted_dict(), messages=messages)

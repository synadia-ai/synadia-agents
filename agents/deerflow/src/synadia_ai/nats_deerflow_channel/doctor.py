"""Doctor checks for the DeerFlow NATS channel."""

from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import httpx
from synadia_ai.agents import NatsContextError, load_context_options, parse_nats_url

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


def _check_nats_target(config: ChannelConfig) -> tuple[bool, str | None]:
    if config.nats_url:
        try:
            options = parse_nats_url(config.nats_url)
            servers = options.get("servers", [])
        except (NatsContextError, ValueError) as exc:
            return False, f"NATS_URL is invalid: {exc}"
        if not servers or any(
            any(ch.isspace() for ch in server)
            or urlparse(server).scheme not in {"nats", "tls", "ws", "wss"}
            for server in servers
        ):
            return False, "NATS_URL is invalid: expected nats://, tls://, ws://, or wss:// URL"
        return True, None

    context = config.nats_context or "current"
    try:
        load_context_options(context)
    except NatsContextError as exc:
        if config.nats_context:
            return False, f"NATS context {config.nats_context!r} could not be loaded: {exc}"
        return False, f"default NATS context could not be loaded: {exc}"
    return True, None


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
        messages.append(
            "owner is not configured; set SYNADIA_DEERFLOW_OWNER, SYNADIA_OWNER, "
            "a legacy NATS_OWNER/DEERFLOW_NATS_OWNER alias, or pass --owner"
        )

    parsed = urlparse(config.deerflow_url)
    checks["deerflow_url_shape"] = parsed.scheme in {"http", "https"} and bool(parsed.netloc)
    if not checks["deerflow_url_shape"]:
        messages.append("deerflow_url must be an http(s) URL")

    checks["nats_target_configured"] = bool(config.nats_context or config.nats_url)
    checks["nats_target_valid"], nats_target_error = _check_nats_target(config)
    if nats_target_error:
        messages.append(nats_target_error)

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
            "nats_target_valid",
            "agent_token_shape",
        )
    )
    return DoctorReport(ok=ok, checks=checks, config=config.redacted_dict(), messages=messages)

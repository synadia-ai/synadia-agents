"""Configuration resolution for the DeerFlow NATS channel."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

DEFAULT_AGENT = "df"
DEFAULT_SESSION = "default"
DEFAULT_DEERFLOW_URL = "http://localhost:2026"
DEFAULT_DEERFLOW_TIMEOUT_S = 60.0
DEFAULT_QUERY_TIMEOUT_S = 300.0
DEFAULT_MAX_PAYLOAD = "1MB"
DEFAULT_CONFIG_PATH = Path("~/.config/synadia/deerflow-channel/config.toml")


@dataclass(frozen=True)
class ChannelConfig:
    """Resolved channel configuration.

    `agent` is the Synadia Agent Protocol token, not the DeerFlow runtime name.
    The MVP uses `df` so subjects stay compact and recognisable.
    """

    agent: str = DEFAULT_AGENT
    owner: str | None = None
    session: str = DEFAULT_SESSION
    deerflow_url: str = DEFAULT_DEERFLOW_URL
    nats_context: str | None = None
    nats_url: str | None = None
    deerflow_timeout_s: float = DEFAULT_DEERFLOW_TIMEOUT_S
    query_timeout_s: float = DEFAULT_QUERY_TIMEOUT_S
    max_payload: str = DEFAULT_MAX_PAYLOAD
    deerflow_cookie: str | None = None
    deerflow_csrf_token: str | None = None
    deerflow_username: str | None = None
    deerflow_password: str | None = None
    config_file: Path | None = None

    @property
    def subject_prefix(self) -> str:
        """Return the protocol subject suffix without the verb."""
        owner = self.owner or "<owner>"
        return f"{self.agent}.{owner}.{self.session}"

    def redacted_dict(self) -> dict[str, str | None]:
        """Return printable non-secret configuration."""
        return {
            "agent": self.agent,
            "owner": self.owner,
            "session": self.session,
            "deerflow_url": self.deerflow_url,
            "nats_context": self.nats_context,
            "nats_url": self.nats_url,
            "deerflow_timeout_s": str(self.deerflow_timeout_s),
            "query_timeout_s": str(self.query_timeout_s),
            "max_payload": self.max_payload,
            "deerflow_cookie": "[REDACTED]" if self.deerflow_cookie else None,
            "deerflow_csrf_token": "[REDACTED]" if self.deerflow_csrf_token else None,
            "deerflow_username": self.deerflow_username,
            "deerflow_password": "[REDACTED]" if self.deerflow_password else None,
            "config_file": str(self.config_file) if self.config_file else None,
            "prompt_subject": f"agents.prompt.{self.subject_prefix}",
            "status_subject": f"agents.status.{self.subject_prefix}",
            "heartbeat_subject": f"agents.hb.{self.subject_prefix}",
        }


def default_config_path() -> Path:
    """Return the conventional Synadia channel config path."""
    return DEFAULT_CONFIG_PATH.expanduser()


def load_config_file(path: Path) -> dict[str, Any]:
    """Load a TOML config file if present."""
    if not path.exists():
        return {}
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"config file {path} did not contain a TOML table")
    return data


def _optional_str(data: dict[str, Any], key: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"config key {key!r} must be a string")
    value = value.strip()
    return value or None


def _optional_positive_float(data: dict[str, Any], key: str) -> float | None:
    value = data.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"config key {key!r} must be a positive number")
    result = float(value)
    if result <= 0:
        raise ValueError(f"config key {key!r} must be > 0")
    return result


def _env(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def _env_positive_float(name: str) -> float | None:
    value = _env(name)
    if value is None:
        return None
    try:
        result = float(value)
    except ValueError as exc:
        raise ValueError(f"environment variable {name} must be a positive number") from exc
    if result <= 0:
        raise ValueError(f"environment variable {name} must be > 0")
    return result


def _apply_file(config: ChannelConfig, data: dict[str, Any], path: Path) -> ChannelConfig:
    return replace(
        config,
        agent=_optional_str(data, "agent") or config.agent,
        owner=_optional_str(data, "owner") or config.owner,
        session=_optional_str(data, "session") or config.session,
        deerflow_url=_optional_str(data, "deerflow_url") or config.deerflow_url,
        nats_context=_optional_str(data, "nats_context") or config.nats_context,
        nats_url=_optional_str(data, "nats_url") or config.nats_url,
        deerflow_timeout_s=_optional_positive_float(data, "deerflow_timeout_s")
        or config.deerflow_timeout_s,
        query_timeout_s=_optional_positive_float(data, "query_timeout_s") or config.query_timeout_s,
        max_payload=_optional_str(data, "max_payload") or config.max_payload,
        deerflow_cookie=_optional_str(data, "deerflow_cookie") or config.deerflow_cookie,
        deerflow_csrf_token=_optional_str(data, "deerflow_csrf_token")
        or config.deerflow_csrf_token,
        deerflow_username=_optional_str(data, "deerflow_username") or config.deerflow_username,
        deerflow_password=_optional_str(data, "deerflow_password") or config.deerflow_password,
        config_file=path,
    )


def _apply_env(config: ChannelConfig) -> ChannelConfig:
    return replace(
        config,
        agent=_env("NATS_AGENT_TOKEN") or _env("DEERFLOW_NATS_AGENT") or config.agent,
        owner=_env("NATS_OWNER") or _env("DEERFLOW_NATS_OWNER") or config.owner,
        session=_env("NATS_AGENT_NAME") or _env("NATS_SESSION") or config.session,
        deerflow_url=_env("DEERFLOW_URL") or config.deerflow_url,
        nats_context=_env("NATS_CONTEXT") or config.nats_context,
        nats_url=_env("NATS_URL") or config.nats_url,
        deerflow_timeout_s=_env_positive_float("DEERFLOW_TIMEOUT_S") or config.deerflow_timeout_s,
        query_timeout_s=_env_positive_float("DEERFLOW_QUERY_TIMEOUT_S") or config.query_timeout_s,
        max_payload=_env("DEERFLOW_MAX_PAYLOAD") or config.max_payload,
        deerflow_cookie=_env("DEERFLOW_COOKIE") or config.deerflow_cookie,
        deerflow_csrf_token=_env("DEERFLOW_CSRF_TOKEN") or config.deerflow_csrf_token,
        deerflow_username=_env("DEERFLOW_USERNAME") or config.deerflow_username,
        deerflow_password=_env("DEERFLOW_PASSWORD") or config.deerflow_password,
    )


def resolve_config(
    *,
    config_file: Path | None = None,
    agent: str | None = None,
    owner: str | None = None,
    session: str | None = None,
    deerflow_url: str | None = None,
    nats_context: str | None = None,
    nats_url: str | None = None,
    deerflow_timeout_s: float | None = None,
    query_timeout_s: float | None = None,
    max_payload: str | None = None,
    deerflow_cookie: str | None = None,
    deerflow_csrf_token: str | None = None,
    deerflow_username: str | None = None,
    deerflow_password: str | None = None,
) -> ChannelConfig:
    """Resolve config as CLI flags → env vars → config file → defaults."""
    path = config_file or default_config_path()
    config = _apply_file(ChannelConfig(config_file=path), load_config_file(path), path)
    config = _apply_env(config)
    return replace(
        config,
        agent=agent or config.agent,
        owner=owner or config.owner,
        session=session or config.session,
        deerflow_url=deerflow_url or config.deerflow_url,
        nats_context=nats_context or config.nats_context,
        nats_url=nats_url or config.nats_url,
        deerflow_timeout_s=deerflow_timeout_s or config.deerflow_timeout_s,
        query_timeout_s=query_timeout_s or config.query_timeout_s,
        max_payload=max_payload or config.max_payload,
        deerflow_cookie=deerflow_cookie or config.deerflow_cookie,
        deerflow_csrf_token=deerflow_csrf_token or config.deerflow_csrf_token,
        deerflow_username=deerflow_username or config.deerflow_username,
        deerflow_password=deerflow_password or config.deerflow_password,
    )

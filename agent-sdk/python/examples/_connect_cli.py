"""Shared CLI → :class:`~nats.aio.client.Client` resolver for the example scripts.

Every numbered example honours the same resolution order:

1. ``--context <name>`` — load from ``~/.config/nats/context/<name>.json``
2. ``--url <url>``      — direct URL (overrides the env var)
3. ``$NATS_URL``        — convenience default for demos; SDK itself does NOT read it
4. selected context     — ``$NATS_CONTEXT`` or ``nats context select`` output
5. ``sys.exit(2)``      — with a pointed message

Mirrors what the TS ``examples/`` do with their inline loader. The SDK
does not open NATS connections — every example builds its own
:class:`~nats.aio.client.Client` via :func:`nats.connect` and hands it to
:class:`~synadia_ai.agents.Agents`. The agent-sdk's reference agent
hands its NATS client to ``synadia_ai.agent_service.AgentService``
the same way.

The leading underscore on the filename is intentional: this helper is
internal plumbing for the examples, not itself a demo.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import TYPE_CHECKING

import nats
from synadia_ai.agents import NatsContextError, load_context_options, parse_nats_url

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


def add_connection_flags(parser: argparse.ArgumentParser) -> None:
    """Wire ``--context`` and ``--url`` onto an example's argparse parser."""
    parser.add_argument(
        "--context",
        metavar="NAME",
        help="load connection settings from `nats context` file <NAME>.json",
    )
    parser.add_argument(
        "--url",
        metavar="URL",
        help="NATS server URL (overrides $NATS_URL)",
    )


async def connect_from_cli(args: argparse.Namespace) -> NATSClient:
    """Resolve CLI flags + env → a connected :class:`~nats.aio.client.Client`.

    URLs (from ``--url`` or ``$NATS_URL``) go through :func:`parse_nats_url`
    so a copy-pasted ``nats://TOKEN@host:port`` works the same way it does
    with the ``nats`` CLI — without it, ``nats-py`` would silently drop the
    token because it doesn't parse credentials from URLs on its own.
    """
    if args.context is not None:
        return await nats.connect(**load_context_options(args.context))
    if args.url is not None:
        return await nats.connect(**parse_nats_url(args.url))
    env_url = os.environ.get("NATS_URL")
    if env_url:
        return await nats.connect(**parse_nats_url(env_url))
    try:
        return await nats.connect(**load_context_options("current"))
    except NatsContextError as exc:
        print(
            "no NATS connection source: pass --context <name> / --url <url>, "
            f"set $NATS_URL, or run `nats context select <name>`.\n  ({exc})",
            file=sys.stderr,
        )
        sys.exit(2)


def _env_owner_default() -> str:
    return os.environ.get("NATS_AGENT_OWNER") or os.environ.get("USER") or "anon"


def _env_session_default(fallback: str) -> str:
    return os.environ.get("NATS_AGENT_NAME") or fallback


def _env_heartbeat_default(fallback: int) -> int:
    raw = os.environ.get("NATS_AGENT_HEARTBEAT_INTERVAL")
    try:
        value = int(raw) if raw else 0
    except ValueError:
        value = 0
    # The SDK requires a positive interval; treat 0 / unset / invalid as the default.
    return value if value > 0 else fallback


def add_agent_identity_flags(
    parser: argparse.ArgumentParser,
    *,
    session_fallback: str = "main",
    heartbeat_fallback: int = 30,
) -> None:
    """Wire ``--owner`` / ``--session-name`` / ``--heartbeat-interval`` onto an agent example.

    Each flag defaults to its ``NATS_AGENT_*`` environment variable, so the
    examples are env-driven like the TS ladder (``NATS_AGENT_OWNER`` /
    ``NATS_AGENT_NAME`` / ``NATS_AGENT_HEARTBEAT_INTERVAL``); an explicit flag
    overrides the env. ``NATS_AGENT_HEARTBEAT_INTERVAL=0`` is treated as unset
    and falls back to ``heartbeat_fallback`` (the SDK requires a positive
    interval).
    """
    parser.add_argument(
        "--owner",
        default=_env_owner_default(),
        help="4th subject token (default: $NATS_AGENT_OWNER, else $USER, else 'anon')",
    )
    parser.add_argument(
        "--session-name",
        default=_env_session_default(session_fallback),
        help=(
            "5th subject token / session this agent serves "
            f"(default: $NATS_AGENT_NAME, else '{session_fallback}')"
        ),
    )
    parser.add_argument(
        "--heartbeat-interval",
        type=int,
        default=_env_heartbeat_default(heartbeat_fallback),
        metavar="SECONDS",
        help=(
            "heartbeat cadence in seconds "
            f"(default: $NATS_AGENT_HEARTBEAT_INTERVAL, else {heartbeat_fallback})"
        ),
    )

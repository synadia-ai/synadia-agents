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


def _agent_env_token(agent: str) -> str:
    """Map an agent's subject token to its per-agent env-var infix.

    ``echo`` → ``ECHO``; ``my-agent`` → ``MY_AGENT`` — uppercased,
    hyphens to underscores, so it composes into ``SYNADIA_<AGENT>_OWNER``.
    """
    return agent.upper().replace("-", "_")


def _env_owner_default(agent: str | None) -> str:
    per_agent = os.environ.get(f"SYNADIA_{_agent_env_token(agent)}_OWNER") if agent else None
    return (
        per_agent
        or os.environ.get("SYNADIA_OWNER")
        or os.environ.get("NATS_AGENT_OWNER")  # legacy alias
        or os.environ.get("USER")
        or "anon"
    )


def _env_session_default(agent: str | None, fallback: str) -> str:
    per_agent = os.environ.get(f"SYNADIA_{_agent_env_token(agent)}_NAME") if agent else None
    return (
        per_agent
        or os.environ.get("SYNADIA_NAME")
        or os.environ.get("NATS_AGENT_NAME")  # legacy alias
        or fallback
    )


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
    agent: str | None = None,
    session_fallback: str = "main",
    heartbeat_fallback: int = 30,
) -> None:
    """Wire ``--owner`` / ``--session-name`` / ``--heartbeat-interval`` onto an agent example.

    Identity flags default through the ``SYNADIA_*`` ladder, so the examples
    are env-driven like the TS agents. For ``--owner`` the order is
    ``SYNADIA_<AGENT>_OWNER`` (per-agent, only when ``agent`` is given) >
    ``SYNADIA_OWNER`` (fleet-wide) > ``NATS_AGENT_OWNER`` (legacy alias) >
    ``$USER`` > ``"anon"``; ``--session-name`` mirrors it with the ``_NAME`` /
    ``SYNADIA_NAME`` / ``NATS_AGENT_NAME`` vars and ``session_fallback``. An
    explicit flag overrides the env. Pass ``agent`` (the example's registered
    subject token) to enable the per-agent override; ``agent=None`` skips it
    (the reference-agent path, whose token is a runtime CLI flag).

    ``<AGENT>`` is the subject token uppercased with hyphens turned into
    underscores (see :func:`_agent_env_token`). The heartbeat flag is config,
    not identity, so it keeps its ``NATS_AGENT_HEARTBEAT_INTERVAL`` var;
    ``NATS_AGENT_HEARTBEAT_INTERVAL=0`` is treated as unset and falls back to
    ``heartbeat_fallback`` (the SDK requires a positive interval).
    """
    if agent is not None:
        owner_vars = f"$SYNADIA_{_agent_env_token(agent)}_OWNER, else $SYNADIA_OWNER"
        name_vars = f"$SYNADIA_{_agent_env_token(agent)}_NAME, else $SYNADIA_NAME"
    else:
        owner_vars = "$SYNADIA_OWNER"
        name_vars = "$SYNADIA_NAME"
    parser.add_argument(
        "--owner",
        default=_env_owner_default(agent),
        help=(
            f"4th subject token (default: {owner_vars}, "
            "else $NATS_AGENT_OWNER, else $USER, else 'anon')"
        ),
    )
    parser.add_argument(
        "--session-name",
        default=_env_session_default(agent, session_fallback),
        help=(
            "5th subject token / session this agent serves "
            f"(default: {name_vars}, else $NATS_AGENT_NAME, else '{session_fallback}')"
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

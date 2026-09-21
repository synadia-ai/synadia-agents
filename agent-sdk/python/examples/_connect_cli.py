"""Shared CLI → NATS connection bundle for the example scripts.

Every numbered example honours the same resolution order:

1. ``--context <name>`` — load from ``~/.config/nats/context/<name>.json``
2. ``--url <url>``      — direct URL (overrides the env var)
3. ``$NATS_URL``        — convenience default for demos; SDK itself does NOT read it
4. selected context     — ``$NATS_CONTEXT`` or ``nats context select`` output
5. ``sys.exit(2)``      — with a pointed message

``--nkey <seed-file>`` / ``$NATS_NKEY_SEED_FILE`` and ``--creds
<creds-file>`` / ``$NATS_CREDS`` are connection credential sources.
``--sender-identity signed`` / ``$NATS_SENDER_IDENTITY=signed`` asks the
SDK connection-bundle helper to derive a signer from that same credential
snapshot. Identity defaults to ``off``. The returned object owns the NATS
client, optional signer, and close-then-wipe lifecycle.

Mirrors the TS examples' ``openExampleNatsConnection`` helper. Credential
parsing and signer construction stay inside
``resolve_nats_connection_bundle``; this file only translates CLI/env
configuration and opens the connection.

The leading underscore on the filename is intentional: this helper is
internal plumbing for the examples, not itself a demo.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import TYPE_CHECKING, Literal

import nats
from synadia_ai.agents import (
    NatsConnectionBundle,
    NatsContextError,
    resolve_nats_connection_bundle,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from synadia_ai.agents import NkeySigner, SenderSigner

IdentityMode = Literal["off", "signed"]


def _identity_mode(value: str) -> IdentityMode:
    if value == "off":
        return "off"
    if value == "signed":
        return "signed"
    raise argparse.ArgumentTypeError("must be 'off' or 'signed'")


class ExampleNatsConnection:
    """One connection and the SDK-owned authentication snapshot behind it."""

    __slots__ = ("bundle", "nc")

    def __init__(
        self,
        nc: NATSClient,
        bundle: NatsConnectionBundle[NkeySigner | None],
    ) -> None:
        self.nc = nc
        self.bundle = bundle

    @property
    def signer(self) -> SenderSigner | None:
        return self.bundle.signer

    async def close(self) -> None:
        """Close NATS before wiping reconnect and signing material."""
        if not self.nc.is_closed:
            await self.nc.close()
        self.bundle.wipe()


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


def add_identity_flags(parser: argparse.ArgumentParser) -> None:
    """Wire connection credentials and the optional signed-identity mode."""
    credentials = parser.add_mutually_exclusive_group()
    credentials.add_argument(
        "--nkey",
        metavar="SEED_FILE",
        default=os.environ.get("NATS_NKEY_SEED_FILE") or None,
        help="user nkey seed file (SU…) for the connection (default: $NATS_NKEY_SEED_FILE)",
    )
    credentials.add_argument(
        "--creds",
        metavar="CREDS_FILE",
        default=os.environ.get("NATS_CREDS") or None,
        help="credentials file (JWT + seed) for the connection (default: $NATS_CREDS)",
    )
    parser.add_argument(
        "--sender-identity",
        type=_identity_mode,
        choices=("off", "signed"),
        default=os.environ.get("NATS_SENDER_IDENTITY") or "off",
        help="outgoing sender identity: off or signed (default: $NATS_SENDER_IDENTITY, else off)",
    )


def _resolve_bundle(args: argparse.Namespace) -> NatsConnectionBundle[NkeySigner | None]:
    """Translate CLI/env configuration into the shared SDK helper once."""
    identity: IdentityMode = args.sender_identity
    if args.context is not None:
        return resolve_nats_connection_bundle(context=args.context, identity=identity)

    url = args.url or os.environ.get("NATS_URL")
    if url:
        return resolve_nats_connection_bundle(
            url=url,
            nkey=getattr(args, "nkey", None),
            creds=getattr(args, "creds", None),
            identity=identity,
        )

    try:
        return resolve_nats_connection_bundle(context="current", identity=identity)
    except NatsContextError as exc:
        print(
            "no NATS connection source: pass --context <name> / --url <url>, "
            f"set $NATS_URL, or run `nats context select <name>`.\n  ({exc})",
            file=sys.stderr,
        )
        sys.exit(2)


async def connect_from_cli(args: argparse.Namespace) -> ExampleNatsConnection:
    """Resolve one SDK bundle, connect from it, and return its lifecycle owner."""
    bundle = _resolve_bundle(args)
    try:
        nc = await nats.connect(**bundle.connection_options)
    except BaseException:
        bundle.wipe()
        raise
    return ExampleNatsConnection(nc=nc, bundle=bundle)


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

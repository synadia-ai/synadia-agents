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
snapshot. Identity defaults to ``off``. ``--sender-name`` only decorates a
signed identity; it never creates a separate unsigned credential path.

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
    Agents,
    Identity,
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
    """One connection, optional identity, and their shared auth snapshot."""

    __slots__ = ("bundle", "nc", "sender_name")

    def __init__(
        self,
        nc: NATSClient,
        bundle: NatsConnectionBundle[NkeySigner | None],
        sender_name: str | None = None,
    ) -> None:
        self.nc = nc
        self.bundle = bundle
        self.sender_name = sender_name

    @property
    def signer(self) -> SenderSigner | None:
        return self.bundle.signer

    @property
    def identity(self) -> Identity | None:
        if self.signer is None:
            return None
        return Identity(signer=self.signer, name=self.sender_name)

    async def close(self) -> None:
        """Close NATS before wiping reconnect and signing material."""
        if not self.nc.is_closed:
            await self.nc.close()
        self.bundle.wipe()


class ExampleAgentsConnection:
    """An ``Agents`` client plus the connection bundle that owns its identity."""

    __slots__ = ("agents", "connection")

    def __init__(self, agents: Agents, connection: ExampleNatsConnection) -> None:
        self.agents = agents
        self.connection = connection

    async def close(self) -> None:
        try:
            await self.agents.close()
        finally:
            await self.connection.close()


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
    """Wire connection credentials and optional signed sender identity."""
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
    parser.add_argument(
        "--sender-name",
        metavar="NAME",
        default=os.environ.get("NATS_SENDER_NAME") or None,
        help="display name carried by signed identity (≤ 64 chars; default: $NATS_SENDER_NAME)",
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
    return ExampleNatsConnection(
        nc=nc,
        bundle=bundle,
        sender_name=getattr(args, "sender_name", None),
    )


async def open_agents_from_cli(args: argparse.Namespace) -> ExampleAgentsConnection:
    """Open ``Agents`` with the bundle signer and one complete cleanup owner."""
    connection = await connect_from_cli(args)
    try:
        agents = Agents(nc=connection.nc, identity=connection.identity)
    except BaseException:
        await connection.close()
        raise
    return ExampleAgentsConnection(agents=agents, connection=connection)

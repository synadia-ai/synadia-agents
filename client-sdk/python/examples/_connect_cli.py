"""Shared CLI → :class:`~nats.aio.client.Client` resolver for the example scripts.

Every numbered example honours the same resolution order:

1. ``--context <name>`` — load from ``~/.config/nats/context/<name>.json``
2. ``--url <url>``      — direct URL (overrides the env var)
3. ``$NATS_URL``        — convenience default for demos; SDK itself does NOT read it
4. selected context     — ``$NATS_CONTEXT`` or ``nats context select`` output
5. ``sys.exit(2)``      — with a pointed message

Sender identity (extension) rides on top: ``--nkey <seed-file>`` /
``$NATS_NKEY_SEED_FILE`` or ``--creds <creds-file>`` / ``$NATS_CREDS``
authenticate the connection **and** build the ``Identity(signer=…)`` the
examples hand to ``Agents`` (``identity_from_cli``); ``--sender-name`` /
``$NATS_SENDER_NAME`` sets the display name. A file, not an environment
value holding the seed, so spawned tool processes do not inherit it.
Without either flag the examples send unsigned claims when the
connection has an NKEY identity and nothing otherwise — 0.3 behaviour.

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
from pathlib import Path
from typing import TYPE_CHECKING, Any

import nats

from synadia_ai.agents import (
    Identity,
    NatsContextError,
    load_context_options,
    parse_nats_url,
    signer_from_creds_file,
    signer_from_seed,
)

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


def add_identity_flags(parser: argparse.ArgumentParser) -> None:
    """Wire ``--nkey`` / ``--creds`` / ``--sender-name`` (sender identity) onto the parser."""
    parser.add_argument(
        "--nkey",
        metavar="SEED_FILE",
        default=os.environ.get("NATS_NKEY_SEED_FILE") or None,
        help="user nkey seed file (SU…): authenticates the connection and signs "
        "Agent-Sender (default: $NATS_NKEY_SEED_FILE)",
    )
    parser.add_argument(
        "--creds",
        metavar="CREDS_FILE",
        default=os.environ.get("NATS_CREDS") or None,
        help="credentials file (JWT + seed): authenticates the connection and signs "
        "Agent-Sender; the identity is read from the JWT (default: $NATS_CREDS)",
    )
    parser.add_argument(
        "--sender-name",
        metavar="NAME",
        default=os.environ.get("NATS_SENDER_NAME") or None,
        help="display name carried in Agent-Sender (≤ 64 chars; default: $NATS_SENDER_NAME)",
    )


def identity_from_cli(args: argparse.Namespace) -> Identity | None:
    """``Identity(signer=…, name=…)`` from ``--nkey`` / ``--creds`` / ``--sender-name``.

    ``None`` when no identity flag is set, so ``Agents(nc=nc, identity=None)``
    keeps the SDK's default (unsigned claims when the connection has an
    NKEY identity).
    """
    nkey = getattr(args, "nkey", None)
    creds = getattr(args, "creds", None)
    name = getattr(args, "sender_name", None)
    if nkey is not None:
        signer = signer_from_seed(Path(nkey).expanduser().read_bytes())
    elif creds is not None:
        signer = signer_from_creds_file(creds)
    elif name is None:
        return None
    else:
        return Identity(name=name)
    return Identity(signer=signer, name=name)


def _auth_kwargs(args: argparse.Namespace) -> dict[str, Any]:
    """nats.connect kwargs for ``--nkey`` / ``--creds`` (the connection half of the identity)."""
    nkey = getattr(args, "nkey", None)
    creds = getattr(args, "creds", None)
    if nkey is not None:
        # nats-py's `nkeys_seed=<path>` reads the file verbatim and rejects a
        # trailing newline; hand it the trimmed seed line instead.
        return {"nkeys_seed_str": Path(nkey).expanduser().read_text(encoding="utf-8").strip()}
    if creds is not None:
        return {"user_credentials": str(Path(creds).expanduser())}
    return {}


async def connect_from_cli(args: argparse.Namespace) -> NATSClient:
    """Resolve CLI flags + env → a connected :class:`~nats.aio.client.Client`.

    URLs (from ``--url`` or ``$NATS_URL``) go through :func:`parse_nats_url`
    so a copy-pasted ``nats://TOKEN@host:port`` works the same way it does
    with the ``nats`` CLI — without it, ``nats-py`` would silently drop the
    token because it doesn't parse credentials from URLs on its own.
    ``--nkey`` / ``--creds`` (see :func:`add_identity_flags`) are merged
    into whichever connection source is active.
    """
    auth = _auth_kwargs(args)
    if args.context is not None:
        return await nats.connect(**{**load_context_options(args.context), **auth})
    if args.url is not None:
        return await nats.connect(**{**parse_nats_url(args.url), **auth})
    env_url = os.environ.get("NATS_URL")
    if env_url:
        return await nats.connect(**{**parse_nats_url(env_url), **auth})
    try:
        return await nats.connect(**{**load_context_options("current"), **auth})
    except NatsContextError as exc:
        print(
            "no NATS connection source: pass --context <name> / --url <url>, "
            f"set $NATS_URL, or run `nats context select <name>`.\n  ({exc})",
            file=sys.stderr,
        )
        sys.exit(2)

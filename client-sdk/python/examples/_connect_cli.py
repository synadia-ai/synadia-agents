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
:class:`~natsagent.Agents` / :class:`~natsagent.AgentService`.

The leading underscore on the filename is intentional: this helper is
internal plumbing for the examples, not itself a demo.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import TYPE_CHECKING

import nats

from natsagent import NatsContextError, load_context_options

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
    """Resolve CLI flags + env → a connected :class:`~nats.aio.client.Client`."""
    if args.context is not None:
        return await nats.connect(**load_context_options(args.context))
    if args.url is not None:
        return await nats.connect(servers=args.url)
    env_url = os.environ.get("NATS_URL")
    if env_url:
        return await nats.connect(servers=env_url)
    try:
        return await nats.connect(**load_context_options("current"))
    except NatsContextError as exc:
        print(
            "no NATS connection source: pass --context <name> / --url <url>, "
            f"set $NATS_URL, or run `nats context select <name>`.\n  ({exc})",
            file=sys.stderr,
        )
        sys.exit(2)

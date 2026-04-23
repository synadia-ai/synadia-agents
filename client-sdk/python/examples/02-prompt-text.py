"""Minimal prompt example — pick the first discovered agent, stream the
response text to stdout, exit on the terminator.

Mirrors ``examples/02-prompt-text.ts`` in the TS SDK.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples._connect_cli import add_connection_flags, connect_from_cli
from natsagent import Client, ResponseChunk, StatusChunk


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Stream a single prompt against the first discovered agent."
    )
    parser.add_argument("text", nargs="?", default="hello", help="prompt text (default: 'hello')")
    parser.add_argument(
        "--session",
        default=None,
        metavar="NAME",
        help=(
            "Optional conversation label on the request envelope (§5.1). "
            "Only needed for agents that multiplex multiple conversations over "
            "one NATS subject (Hermes-style). For most agents, running this "
            "script repeatedly against the same discovered subject already "
            "gives you chat — the subject IS the session."
        ),
    )
    add_connection_flags(parser)
    args = parser.parse_args()

    nc = await connect_from_cli(args)
    client = Client(nc)
    try:
        agents = await client.discover(timeout=2.0)
        if not agents:
            print("no agents found — start the reference agent first.", file=sys.stderr)
            sys.exit(2)
        remote = client.bind(agents[0])
        async for msg in remote.prompt(args.text, session=args.session):
            if isinstance(msg, ResponseChunk):
                sys.stdout.write(msg.text)
                sys.stdout.flush()
            elif isinstance(msg, StatusChunk):
                if msg.status == "done":
                    sys.stdout.write("\n")
                    sys.stdout.flush()
    finally:
        await client.stop()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())

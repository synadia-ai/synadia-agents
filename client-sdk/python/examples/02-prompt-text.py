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
from synadia_ai.agents import Agents, DiscoverFilter, ResponseChunk, StatusChunk


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
            "Select the agent whose `session_name` matches NAME — i.e. the "
            "5th subject token (v0.3). When omitted, the first discovered "
            "agent is used."
        ),
    )
    add_connection_flags(parser)
    args = parser.parse_args()

    nc = await connect_from_cli(args)
    agents = Agents(nc=nc)
    try:
        filt = DiscoverFilter(session_name=args.session) if args.session else None
        found = await agents.discover(filter=filt)
        if not found:
            print("no agents found — start the reference agent first.", file=sys.stderr)
            sys.exit(2)
        agent = found[0]
        async for msg in agent.prompt(args.text):
            if isinstance(msg, ResponseChunk):
                sys.stdout.write(msg.text)
                sys.stdout.flush()
            elif isinstance(msg, StatusChunk):
                if msg.status == "done":
                    sys.stdout.write("\n")
                    sys.stdout.flush()
    finally:
        await agents.close()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())

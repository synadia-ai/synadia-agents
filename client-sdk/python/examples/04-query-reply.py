"""Demonstrates mid-stream query handling.

Mirrors ``examples/04-query-reply.ts``: the agent pauses its response to
ask a clarifying question; the caller answers; the agent continues.
Run a query-capable agent of your own — the reference agent's echo
handler doesn't emit queries.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples._connect_cli import add_connection_flags, connect_from_cli
from synadia_ai.agents import Agents, DiscoverFilter, Query, ResponseChunk, StatusChunk


async def _ask(prompt: str) -> str:
    """Read one line from stdin without blocking the event loop."""
    return await asyncio.to_thread(input, f"{prompt} ")


async def _handle_query(q: Query) -> None:
    sys.stdout.write(f"\n[agent asks: {q.prompt}]\n")
    sys.stdout.flush()
    answer = await _ask(">")
    await q.reply(answer)


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prompt an agent and interactively answer any mid-stream queries it asks."
    )
    parser.add_argument("text", nargs="?", default="plan the migration", help="prompt text")
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
            print("no agents found.", file=sys.stderr)
            sys.exit(2)
        agent = found[0]

        async for msg in agent.prompt(args.text):
            if isinstance(msg, ResponseChunk):
                sys.stdout.write(msg.text)
                sys.stdout.flush()
            elif isinstance(msg, Query):
                await _handle_query(msg)
            elif isinstance(msg, StatusChunk):
                if msg.status == "done":
                    sys.stdout.write("\n[done]\n")
                    sys.stdout.flush()
    finally:
        await agents.close()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())

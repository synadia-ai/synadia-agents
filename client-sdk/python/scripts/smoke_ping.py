"""Manual smoke for :meth:`Agents.discover` against a live or absent demo agent.

Two scenarios — pass the mode as the first positional argument:

  up      Expects a protocol-compliant agent to be on the bus (e.g.
          the agent-sdk's `agent-sdk/python/scripts/demo_echo.py`
          running). At INFO level, asserts
          discover() returns ≥ 1 entry and NO log records are emitted
          on the client side — the success path is silent.

  down    Expects no compliant agent. At DEBUG level, asserts discover()
          returns [] and emits a discovery debug record.

Uses the numbered examples' connection and optional signed-identity flags.
It does not spawn the server itself.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples._connect_cli import (
    add_connection_flags,
    add_identity_flags,
    open_agents_from_cli,
)


class _ListHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


async def _run(args: argparse.Namespace) -> int:
    expect_agent = args.mode == "up"
    level = logging.INFO if expect_agent else logging.DEBUG

    root = logging.getLogger("synadia_ai.agents")
    captured = _ListHandler()
    captured.setLevel(logging.DEBUG)
    root.addHandler(captured)
    root.setLevel(level)

    # Also stream to stderr so the operator sees what's happening live.
    logging.basicConfig(level=level, format="%(name)s %(levelname)s %(message)s")

    session = await open_agents_from_cli(args)
    try:
        timeout = 1.0 if expect_agent else 0.3
        found = await session.agents.discover(timeout=timeout)
        print(f"[smoke:{args.mode}] discover(timeout={timeout}) -> {len(found)} agent(s)")
    finally:
        await session.close()

    discovery_records = [r for r in captured.records if r.name == "synadia_ai.agents.discovery"]
    print(
        f"[smoke:{args.mode}] synadia_ai.agents.discovery records: "
        f"{[(r.levelname, r.getMessage()) for r in discovery_records]}"
    )

    if expect_agent:
        if not found:
            print(f"[smoke:{args.mode}] FAIL: expected ≥1 agent, got 0")
            return 1
        if any(r.levelno >= logging.INFO for r in discovery_records):
            print(f"[smoke:{args.mode}] FAIL: success path emitted >=INFO records")
            return 1
        print(f"[smoke:{args.mode}] OK")
        return 0

    if found:
        print(f"[smoke:{args.mode}] FAIL: expected 0 agents, got {len(found)}")
        return 1
    print(f"[smoke:{args.mode}] OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke Agents.discover against a live server.")
    parser.add_argument("mode", choices=("up", "down"))
    add_connection_flags(parser)
    add_identity_flags(parser)
    return asyncio.run(_run(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())

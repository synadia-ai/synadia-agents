"""Manual smoke for :meth:`Agents.discover` against a live or absent demo agent.

Two scenarios — pass the mode as the first positional argument:

  up      Expects a protocol-compliant agent to be on the bus (e.g.
          `scripts/demo_echo.py` running). At INFO level, asserts
          discover() returns ≥ 1 entry and NO log records are emitted
          on the client side — the success path is silent.

  down    Expects no compliant agent. At DEBUG level, asserts discover()
          returns [] and emits a discovery debug record.

Requires `nats-server` reachable at `$NATS_URL` (default
`nats://127.0.0.1:4222`). Does not spawn the server itself.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

import nats

from synadia_ai.agents import Agents


class _ListHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


async def _run(mode: str) -> int:
    expect_agent = mode == "up"
    level = logging.INFO if expect_agent else logging.DEBUG

    root = logging.getLogger("synadia_ai.agents")
    captured = _ListHandler()
    captured.setLevel(logging.DEBUG)
    root.addHandler(captured)
    root.setLevel(level)

    # Also stream to stderr so the operator sees what's happening live.
    logging.basicConfig(level=level, format="%(name)s %(levelname)s %(message)s")

    url = os.environ.get("NATS_URL", "nats://127.0.0.1:4222")
    nc = await nats.connect(url)
    try:
        agents = Agents(nc=nc)
        try:
            timeout = 1.0 if expect_agent else 0.3
            found = await agents.discover(timeout=timeout)
            print(f"[smoke:{mode}] discover(timeout={timeout}) -> {len(found)} agent(s)")
        finally:
            await agents.close()
    finally:
        await nc.close()

    discovery_records = [r for r in captured.records if r.name == "synadia_ai.agents.discovery"]
    print(
        f"[smoke:{mode}] synadia_ai.agents.discovery records: "
        f"{[(r.levelname, r.getMessage()) for r in discovery_records]}"
    )

    if expect_agent:
        if not found:
            print(f"[smoke:{mode}] FAIL: expected ≥1 agent, got 0")
            return 1
        if any(r.levelno >= logging.INFO for r in discovery_records):
            print(f"[smoke:{mode}] FAIL: success path emitted >=INFO records")
            return 1
        print(f"[smoke:{mode}] OK")
        return 0

    if found:
        print(f"[smoke:{mode}] FAIL: expected 0 agents, got {len(found)}")
        return 1
    print(f"[smoke:{mode}] OK")
    return 0


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"up", "down"}:  # noqa: PLR2004
        print("usage: smoke_ping.py {up|down}", file=sys.stderr)
        return 2
    return asyncio.run(_run(sys.argv[1]))


if __name__ == "__main__":
    raise SystemExit(main())

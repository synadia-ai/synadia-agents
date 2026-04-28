"""Live view of every reachable agent's heartbeat.

Mirrors ``examples/05-liveness.ts``. The Python :class:`Agents` keeps a
passive heartbeat tracker keyed on ``instance_id`` (§8.3). We register a
per-instance listener for each discovered agent so beats are logged as
they arrive, and print a tracker snapshot every 5 seconds.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import signal
import sys
from collections.abc import Callable
from pathlib import Path
from types import FrameType

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples._connect_cli import add_connection_flags, connect_from_cli
from synadia_ai.agents import Agents, HeartbeatPayload


def _make_listener(identity: str) -> Callable[[HeartbeatPayload], None]:
    def _listener(payload: HeartbeatPayload) -> None:
        print(f"[{payload.ts}] {identity}: interval={payload.interval_s}s")

    return _listener


async def main() -> None:
    parser = argparse.ArgumentParser(description="Watch heartbeats for every reachable agent.")
    add_connection_flags(parser)
    args = parser.parse_args()

    nc = await connect_from_cli(args)
    agents = Agents(nc=nc)
    stop = asyncio.Event()

    def _on_signal(_sig: int, _frame: FrameType | None) -> None:
        stop.set()

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    # Heartbeat wildcard sub BEFORE discover() per §8.5.
    await agents.start_tracking()
    unsubscribers: list[Callable[[], None]] = []
    try:
        found = await agents.discover()
        print(f"tracking {len(found)} agent(s). Press Ctrl+C to stop.\n")

        for a in found:
            identity = f"{a.agent}/{a.owner}/{a.session_name or '<custom>'}"
            unsubscribers.append(agents.on_heartbeat(a.instance_id, _make_listener(identity)))

        while not stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=5.0)
            print("\n--- liveness snapshot ---")
            for a in found:
                liveness = agents.liveness(a.instance_id)
                identity = f"{a.agent}/{a.owner}/{a.session_name or '<custom>'}"
                if liveness is None:
                    print(f"  {identity}: no heartbeat yet")
                else:
                    print(
                        f"  {identity}: last_seen={liveness.last_seen.isoformat()}, "
                        f"online={liveness.is_online}"
                    )
            print("-------------------------\n")
    finally:
        for unsub in unsubscribers:
            with contextlib.suppress(Exception):
                unsub()
        await agents.close()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())

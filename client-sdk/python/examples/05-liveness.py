"""Live view of every reachable agent's heartbeat.

Mirrors ``examples/05-liveness.ts``. The Python :class:`Client` has a
passive heartbeat tracker (wildcard subscription) — we also attach our
own subscription to the heartbeat wildcard so we can log each beat as
it arrives. A snapshot is printed every 5 seconds.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import signal
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import FrameType

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples._connect_cli import add_connection_flags, connect_from_cli
from natsagent import Client, HeartbeatPayload


async def main() -> None:
    parser = argparse.ArgumentParser(description="Watch heartbeats for every reachable agent.")
    add_connection_flags(parser)
    args = parser.parse_args()

    nc = await connect_from_cli(args)
    client = Client(nc)
    stop = asyncio.Event()

    def _on_signal(_sig: int, _frame: FrameType | None) -> None:
        stop.set()

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    async def _on_heartbeat(msg: object) -> None:
        subject: str = msg.subject  # type: ignore[attr-defined]
        data: bytes = msg.data  # type: ignore[attr-defined]
        try:
            hb = HeartbeatPayload.model_validate_json(data)
        except Exception as exc:
            print(f"[{_now_iso()}] malformed heartbeat on {subject}: {exc}")
            return
        inbox = subject.removesuffix(".heartbeat")
        status = client.status(inbox)
        print(
            f"[{hb.ts}] {hb.agent}/{hb.owner}: interval={hb.interval_s}s, "
            f"online={status.is_online()}"
        )

    # Heartbeat wildcard sub BEFORE discover() per §8.5.
    await client.start()
    hb_sub = await nc.subscribe("agents.*.*.*.heartbeat", cb=_on_heartbeat)

    try:
        agents = await client.discover(timeout=2.0)
        print(f"tracking {len(agents)} agent(s). Press Ctrl+C to stop.\n")

        while not stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=5.0)
            print("\n--- status snapshot ---")
            for a in agents:
                status = client.status(a.inbox)
                if status.last_seen is None:
                    print(f"  {a.agent}/{a.name}: no heartbeat yet")
                else:
                    print(
                        f"  {a.agent}/{a.name}: last_seen={status.last_seen.isoformat()}, "
                        f"online={status.is_online()}"
                    )
            print("-----------------------\n")
    finally:
        await hb_sub.unsubscribe()
        await client.stop()
        await nc.close()


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


if __name__ == "__main__":
    asyncio.run(main())

"""Manual smoke for `Client.ping()` against a live or absent demo agent.

Two scenarios — pass the mode as the first positional argument:

  up      Expects a protocol-compliant agent to be on the bus (e.g.
          `scripts/demo_echo.py` running). At INFO level, asserts ping
          returns True and NO log records are emitted on the client side
          — the success path is silent.

  down    Expects no compliant agent. At DEBUG level, asserts ping
          returns False and the `natsagent.client` logger emitted the
          "no compliant agent responded" record.

Requires `nats-server` reachable at `$NATS_URL` (default
`nats://127.0.0.1:4222`). Does not spawn the server itself.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

import nats

from natsagent import Client


class _ListHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


async def _run(mode: str) -> int:
    expect_agent = mode == "up"
    level = logging.INFO if expect_agent else logging.DEBUG

    root = logging.getLogger("natsagent")
    captured = _ListHandler()
    captured.setLevel(logging.DEBUG)
    root.addHandler(captured)
    root.setLevel(level)

    # Also stream to stderr so the operator sees what's happening live.
    logging.basicConfig(level=level, format="%(name)s %(levelname)s %(message)s")

    url = os.environ.get("NATS_URL", "nats://127.0.0.1:4222")
    nc = await nats.connect(url)
    try:
        client = Client(nc=nc)
        await client.start()
        try:
            timeout = 1.0 if expect_agent else 0.3
            result = await client.ping(timeout=timeout)
            print(f"[smoke:{mode}] ping(timeout={timeout}) -> {result}")
        finally:
            await client.stop()
    finally:
        await nc.close()

    client_records = [r for r in captured.records if r.name == "natsagent.client"]
    print(
        f"[smoke:{mode}] natsagent.client records: "
        f"{[(r.levelname, r.getMessage()) for r in client_records]}"
    )

    if expect_agent:
        if result is not True:
            print(f"[smoke:{mode}] FAIL: expected True, got {result!r}")
            return 1
        if any(r.levelno >= logging.INFO for r in client_records):
            print(f"[smoke:{mode}] FAIL: success path emitted >=INFO records")
            return 1
        print(f"[smoke:{mode}] OK")
        return 0

    if result is not False:
        print(f"[smoke:{mode}] FAIL: expected False, got {result!r}")
        return 1
    # Two shapes are valid: TimeoutError ("no compliant agent responded")
    # and NoRespondersError ("broker reports no responders"). Both mean
    # the same thing from a caller's perspective — no agent reachable.
    if not any(
        r.levelno == logging.DEBUG
        and ("no compliant agent responded" in r.getMessage() or "no responders" in r.getMessage())
        for r in client_records
    ):
        print(f"[smoke:{mode}] FAIL: missing expected DEBUG record")
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

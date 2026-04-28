"""Run a protocol-compliant echo agent for manual poking with the `nats` CLI.

Usage:
    uv run python scripts/demo_echo.py

Prereq: `nats-server` running locally (default `nats://127.0.0.1:4222`).
Override with NATS_URL in the environment.

Once running, try from another shell (subjects are verb-first per v0.3):

    nats micro list
    nats req  agents.prompt.demo.$USER.echo "hello"
    nats req  agents.status.demo.$USER.echo ""
    nats sub  "agents.hb.demo.$USER.echo"
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from types import FrameType

import nats

from synadia_ai.agents import AgentService, Envelope, PromptStream


async def echo_handler(envelope: Envelope, stream: PromptStream) -> None:
    await stream.send(f"echo: {envelope.prompt}")


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    url = os.environ.get("NATS_URL", "nats://127.0.0.1:4222")
    owner = os.environ.get("USER", "anon")
    nc = await nats.connect(url)

    agent = AgentService(
        agent="demo",
        owner=owner,
        session_name="echo",
        nc=nc,
        description="demo echo agent",
        heartbeat_interval_s=5,
    )
    agent.on_prompt(echo_handler)
    await agent.start()

    print(f"Echo agent ready on {agent.subject.prompt}")
    print(f"Try: nats req {agent.subject.prompt} 'hello'")
    print(f"     nats req {agent.subject.status} ''")
    print("Ctrl-C to stop.")

    stop = asyncio.Event()

    def _on_signal(_sig: int, _frame: FrameType | None) -> None:
        stop.set()

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    try:
        await stop.wait()
    finally:
        await agent.stop()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())

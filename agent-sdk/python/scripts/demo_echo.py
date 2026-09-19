"""Run a protocol-compliant echo agent for manual poking with the `nats` CLI.

Usage:
    uv run python scripts/demo_echo.py --url nats://127.0.0.1:4222

Connection flags and identity mode are the same as the numbered examples.

Once running, try from another shell (subjects are verb-first per v0.3):

    nats micro list
    nats req  agents.prompt.demo.$USER.echo "hello"
    nats req  agents.status.demo.$USER.echo ""
    nats sub  "agents.hb.demo.$USER.echo"
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
from pathlib import Path
from types import FrameType

from synadia_ai.agents import Envelope

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples._connect_cli import (
    add_connection_flags,
    add_identity_flags,
    connect_from_cli,
)

from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity


async def echo_handler(envelope: Envelope, stream: PromptStream) -> None:
    await stream.send(f"echo: {envelope.prompt}")


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    parser = argparse.ArgumentParser(description="Run a protocol-compliant demo echo agent.")
    add_connection_flags(parser)
    add_identity_flags(parser)
    args = parser.parse_args()

    owner = os.environ.get("USER", "anon")
    connection = await connect_from_cli(args)
    try:
        agent = AgentService(
            agent="demo",
            owner=owner,
            session_name="echo",
            nc=connection.nc,
            description="demo echo agent",
            heartbeat_interval_s=5,
            identity=(
                ServiceIdentity(signer=connection.signer) if connection.signer is not None else None
            ),
        )
    except BaseException:
        await connection.close()
        raise
    try:
        agent.on_prompt(echo_handler)
        await agent.start()
    except BaseException:
        try:
            await agent.stop()
        finally:
            await connection.close()
        raise

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
        try:
            await agent.stop()
        finally:
            await connection.close()


if __name__ == "__main__":
    asyncio.run(main())

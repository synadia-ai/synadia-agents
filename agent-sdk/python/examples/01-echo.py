# 01 · Echo agent — the smallest Synadia Agent Protocol agent (Python).
#
# Replies to every prompt with `echo: <prompt text>`. No LLM, no state — just
# enough to show the shape of an agent built on AgentService: connect to NATS,
# construct the service, handle prompts, start, shut down. Python mirror of
# agent-sdk/typescript/examples/01-echo.ts.
#
# Identity → subject agents.prompt.echo.<owner>.<session_name>. Owner and the
# session name are overridable (--owner / --session-name, or $NATS_AGENT_OWNER /
# $NATS_AGENT_NAME) so several people can run this against one server without
# colliding. --heartbeat-interval / $NATS_AGENT_HEARTBEAT_INTERVAL tunes the
# heartbeat cadence (default 30s).
#
# Connection: --context / --url, else $NATS_CONTEXT / $NATS_URL, else the
# selected `nats` context. Run with -h for the full flag list.

from __future__ import annotations

import argparse
import asyncio
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from synadia_ai.agents import Envelope

from examples._connect_cli import (
    add_agent_identity_flags,
    add_connection_flags,
    connect_from_cli,
)
from synadia_ai.agent_service import AgentService, PromptStream


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Echo agent — replies with the prompt prefixed by 'echo: '."
    )
    add_connection_flags(parser)
    add_agent_identity_flags(parser)
    args = parser.parse_args()

    nc = await connect_from_cli(args)

    service = AgentService(
        agent="echo",
        owner=args.owner,
        session_name=args.session_name,
        nc=nc,
        description="Echo agent — replies with the prompt prefixed by 'echo: '",
        heartbeat_interval_s=args.heartbeat_interval,
    )

    # The whole agent. Every incoming prompt runs this handler; whatever we
    # stream.send(...) is the reply. Here we send one chunk; an LLM agent would
    # send many, token by token.
    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        await stream.send(f"echo: {envelope.prompt}")

    service.on_prompt(handler)
    await service.start()
    print(f"echo agent listening on {service.subject.prompt}")
    print("press Ctrl+C to stop")

    # add_signal_handler is the asyncio-safe way to wake `await stop.wait()`;
    # signal.signal + Event.set() does not reliably notify the running loop.
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for _sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(_sig, stop.set)
    try:
        await stop.wait()
    finally:
        print("\nshutting down…")
        await service.stop()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())

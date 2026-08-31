"""Signed Echo AgentService that accepts only verified senders."""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
from pathlib import Path
from typing import TYPE_CHECKING

from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agents import Envelope, NkeySigner, SenderInfo, format_sender

from _common import (
    DEFAULT_NATS_URL,
    OWNER,
    SESSION_NAME,
    connect_user,
    default_seed_path,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

log = logging.getLogger("identity_workbook.echo")


async def start_echo(
    nc: NATSClient,
    signer: NkeySigner,
    *,
    seen_senders: list[SenderInfo | None] | None = None,
) -> AgentService:
    """Start Echo and optionally expose its classified senders to an e2e test."""
    service = AgentService(
        agent="echo",
        owner=OWNER,
        session_name=SESSION_NAME,
        nc=nc,
        description="Python sender-identity workbook Echo",
        identity=ServiceIdentity(signer=signer),
        min_sender_trust="signed",
    )

    async def echo(envelope: Envelope, stream: PromptStream) -> None:
        sender = stream.sender
        if seen_senders is not None:
            seen_senders.append(sender)
        # format_sender includes the trust class, but never the nonce or signature.
        log.info("incoming sender=%s", format_sender(sender))
        await stream.send(envelope.prompt)

    service.on_prompt(echo)
    await service.start()
    log.info(
        "Echo identity=%s min_sender_trust=%s subject=%s",
        service.identity,
        service.min_sender_trust,
        service.subject.prompt,
    )
    return service


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_NATS_URL, help="NATS server URL")
    parser.add_argument(
        "--nkey",
        type=Path,
        default=default_seed_path("echo"),
        help="Echo user seed file (default: .local/echo.nkey)",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")

    user = await connect_user(args.url, args.nkey)
    service: AgentService | None = None
    try:
        service = await start_echo(user.nc, user.signer)
        print("Echo is ready; press Ctrl+C to stop")
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        await stop.wait()
    finally:
        if service is not None:
            await service.stop()
        await user.close()


if __name__ == "__main__":
    asyncio.run(main())

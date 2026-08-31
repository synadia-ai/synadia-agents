"""Run signed Hello, forwarding each received prompt to signed Echo."""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agents import Agents, Envelope, Identity, NkeySigner, SenderInfo

from _common import (
    DEFAULT_NATS_URL,
    OWNER,
    SESSION_NAME,
    connect_user,
    default_seed_path,
    describe_sender,
    discover_verified_echo,
    response_text,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

log = logging.getLogger("identity_workbook.hello")


@dataclass(frozen=True, slots=True)
class RunningHello:
    """Hello's service and caller-side SDK share one connection and signer."""

    service: AgentService
    agents: Agents

    async def stop(self) -> None:
        """Stop serving, then release the caller-side SDK state."""
        await self.service.stop()
        await self.agents.close()


async def start_hello(
    nc: NATSClient,
    signer: NkeySigner,
    *,
    seen_senders: list[SenderInfo | None] | None = None,
) -> RunningHello:
    """Register Hello and forward each incoming prompt to verified Echo."""
    agents = Agents(nc=nc, identity=Identity(signer=signer, name="Hello"))
    service = AgentService(
        agent="hello",
        owner=OWNER,
        session_name=SESSION_NAME,
        nc=nc,
        description="Python sender-identity workbook Hello",
        identity=ServiceIdentity(signer=signer),
        min_sender_trust="any",
    )

    async def hello(envelope: Envelope, stream: PromptStream) -> None:
        sender = stream.sender
        if seen_senders is not None:
            seen_senders.append(sender)
        log.info("incoming sender=%s", describe_sender(sender))

        echo = await discover_verified_echo(agents)
        assert echo.identity is not None  # established by discover_verified_echo
        forwarded_prompt = f"Hello! {envelope.prompt}"
        log.info(
            "discovered Echo identity=%s id_sig_verified=%s",
            echo.identity,
            echo.id_sig_verified,
        )
        log.info(
            "outgoing prompt identity=%s mode=signed recipient=%s prompt=%r",
            service.identity,
            echo.identity,
            forwarded_prompt,
        )
        response = await response_text(echo.prompt(forwarded_prompt))
        log.info("Echo replied=%r", response)
        await stream.send(response)

    service.on_prompt(hello)
    try:
        await service.start()
    except BaseException:
        await agents.close()
        raise
    log.info(
        "Hello identity=%s min_sender_trust=%s subject=%s",
        service.identity,
        service.min_sender_trust,
        service.subject.prompt,
    )
    return RunningHello(service=service, agents=agents)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_NATS_URL, help="NATS server URL")
    parser.add_argument(
        "--nkey",
        type=Path,
        default=default_seed_path("hello"),
        help="Hello user seed file (default: .local/hello.nkey)",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")

    user = await connect_user(args.url, args.nkey)
    hello: RunningHello | None = None
    try:
        hello = await start_hello(user.nc, user.signer)
        print("Hello is ready; press Ctrl+C to stop")
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        await stop.wait()
    finally:
        if hello is not None:
            await hello.stop()
        await user.close()


if __name__ == "__main__":
    asyncio.run(main())

"""Register signed Hello, then call Echo as that same connection identity."""

from __future__ import annotations

import argparse
import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agents import AgentId, Agents, Envelope, Identity, NkeySigner, format_sender

from _common import (
    DEFAULT_NATS_URL,
    OWNER,
    SESSION_NAME,
    connect_user,
    default_seed_path,
    discover_verified_echo,
    response_text,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

log = logging.getLogger("identity_workbook.hello")


@dataclass(frozen=True, slots=True)
class HelloCall:
    hello_identity: AgentId
    echo_identity: AgentId
    echo_id_sig_verified: bool
    response: str


async def start_hello(nc: NATSClient, signer: NkeySigner) -> AgentService:
    """Register Hello as its own signed, sender-identity-aware service."""
    service = AgentService(
        agent="hello",
        owner=OWNER,
        session_name=SESSION_NAME,
        nc=nc,
        description="Python sender-identity workbook Hello",
        identity=ServiceIdentity(signer=signer),
        min_sender_trust="signed",
    )

    async def hello(envelope: Envelope, stream: PromptStream) -> None:
        log.info("incoming sender=%s", format_sender(stream.sender))
        await stream.send(envelope.prompt)

    service.on_prompt(hello)
    await service.start()
    log.info("Hello identity=%s subject=%s", service.identity, service.subject.prompt)
    return service


async def call_echo_as_hello(nc: NATSClient, signer: NkeySigner) -> HelloCall:
    """Use Hello's signer and connection identity to send the literal prompt ``hello``."""
    agents = Agents(nc=nc, identity=Identity(signer=signer, name="Hello"))
    try:
        echo = await discover_verified_echo(agents)
        assert echo.identity is not None  # established by discover_verified_echo
        hello_identity = await agents.self_id()
        log.info(
            "discovered Echo identity=%s id_sig_verified=%s",
            echo.identity,
            echo.id_sig_verified,
        )
        log.info(
            "outgoing signed prompt sender=%s recipient=%s prompt='hello'",
            hello_identity,
            echo.identity,
        )
        response = await response_text(echo.prompt("hello"))
        return HelloCall(
            hello_identity=hello_identity,
            echo_identity=echo.identity,
            echo_id_sig_verified=echo.id_sig_verified,
            response=response,
        )
    finally:
        await agents.close()


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
    service: AgentService | None = None
    try:
        service = await start_hello(user.nc, user.signer)
        result = await call_echo_as_hello(user.nc, user.signer)
        if service.identity != result.hello_identity:
            raise RuntimeError("Hello's service and caller identities do not match")
        print(result.response)
    finally:
        if service is not None:
            await service.stop()
        await user.close()


if __name__ == "__main__":
    asyncio.run(main())

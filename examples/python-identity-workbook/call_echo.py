"""Discover the signed Echo agent and call it with a signed CLI identity."""

from __future__ import annotations

import argparse
import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from synadia_ai.agents import AgentId, Agents, Identity, NkeySigner

from _common import (
    DEFAULT_NATS_URL,
    connect_user,
    default_seed_path,
    discover_verified_echo,
    response_text,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

log = logging.getLogger("identity_workbook.cli")


@dataclass(frozen=True, slots=True)
class EchoCall:
    caller_identity: AgentId
    echo_identity: AgentId
    echo_id_sig_verified: bool
    response: str


async def call_echo(nc: NATSClient, signer: NkeySigner, prompt: str) -> EchoCall:
    """Call Echo through the client SDK, using the connection's matching signer."""
    agents = Agents(nc=nc, identity=Identity(signer=signer, name="CLI"))
    try:
        echo = await discover_verified_echo(agents)
        assert echo.identity is not None  # established by discover_verified_echo
        caller_identity = await agents.self_id()
        log.info(
            "discovered Echo identity=%s id_sig_verified=%s",
            echo.identity,
            echo.id_sig_verified,
        )
        # The SDK signs at publish time. Log the intent and identities, never the
        # generated nonce or raw Agent-Sender signature.
        log.info(
            "outgoing signed prompt sender=%s recipient=%s prompt=%r",
            caller_identity,
            echo.identity,
            prompt,
        )
        response = await response_text(echo.prompt(prompt))
        return EchoCall(
            caller_identity=caller_identity,
            echo_identity=echo.identity,
            echo_id_sig_verified=echo.id_sig_verified,
            response=response,
        )
    finally:
        await agents.close()


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="?", default="hello from CLI")
    parser.add_argument("--url", default=DEFAULT_NATS_URL, help="NATS server URL")
    parser.add_argument(
        "--nkey",
        type=Path,
        default=default_seed_path("cli"),
        help="CLI user seed file (default: .local/cli.nkey)",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")

    user = await connect_user(args.url, args.nkey)
    try:
        result = await call_echo(user.nc, user.signer, args.prompt)
        print(result.response)
    finally:
        await user.close()


if __name__ == "__main__":
    asyncio.run(main())

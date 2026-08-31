"""Discover a signed workbook agent and call it with or without sender identity."""

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
    discover_verified_agent,
    response_text,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

log = logging.getLogger("identity_workbook.cli")


@dataclass(frozen=True, slots=True)
class AgentCall:
    caller_identity: AgentId | None
    target_identity: AgentId
    target_id_sig_verified: bool
    response: str


async def call_agent(
    nc: NATSClient,
    signer: NkeySigner | None,
    prompt: str,
    *,
    agent_name: str = "echo",
) -> AgentCall:
    """Call a workbook agent, omitting Agent-Sender when signer is ``None``."""
    identity = Identity(signer=signer, name="CLI") if signer is not None else None
    agents = Agents(nc=nc, identity=identity)
    try:
        target = await discover_verified_agent(agents, agent_name)
        assert target.identity is not None  # established by discover_verified_agent
        caller_identity = await agents.self_id() if signer is not None else None
        log.info(
            "discovered %s identity=%s id_sig_verified=%s",
            agent_name.title(),
            target.identity,
            target.id_sig_verified,
        )
        if caller_identity is not None:
            # The SDK signs at publish time. Log the intent and identities, never
            # the generated nonce or raw Agent-Sender signature.
            log.info(
                "outgoing prompt identity=%s mode=signed recipient=%s prompt=%r",
                caller_identity,
                target.identity,
                prompt,
            )
        else:
            log.info(
                "outgoing prompt identity=(none) mode=without-identity recipient=%s prompt=%r",
                target.identity,
                prompt,
            )
        response = await response_text(target.prompt(prompt))
        return AgentCall(
            caller_identity=caller_identity,
            target_identity=target.identity,
            target_id_sig_verified=target.id_sig_verified,
            response=response,
        )
    finally:
        await agents.close()


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="?", default="hello from CLI")
    parser.add_argument(
        "--agent",
        choices=("echo", "hello"),
        default="echo",
        help="workbook agent to call (default: echo)",
    )
    parser.add_argument("--url", default=DEFAULT_NATS_URL, help="NATS server URL")
    parser.add_argument(
        "--nkey",
        type=Path,
        default=default_seed_path("cli"),
        help="CLI user seed file (default: .local/cli.nkey)",
    )
    parser.add_argument(
        "--without-identity",
        action="store_true",
        help="omit Agent-Sender (the NATS connection is still authenticated as the CLI user)",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(name)s %(levelname)s %(message)s")

    user = await connect_user(args.url, args.nkey)
    try:
        signer = None if args.without_identity else user.signer
        result = await call_agent(user.nc, signer, args.prompt, agent_name=args.agent)
        print(result.response)
    finally:
        await user.close()


if __name__ == "__main__":
    asyncio.run(main())

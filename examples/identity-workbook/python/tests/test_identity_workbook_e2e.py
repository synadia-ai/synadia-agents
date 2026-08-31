"""End-to-end proof for the workbook's Echo, Hello, and CLI identities."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Protocol

import pytest
from synadia_ai.agents import (
    AgentId,
    Agents,
    DiscoverFilter,
    Identity,
    SenderInfo,
    VerifiedSender,
)

from _common import OWNER, SESSION_NAME, connect_user
from call_echo import call_echo
from echo_agent import start_echo
from hello_agent import call_echo_as_hello, start_hello
from prepare_nkeys import ProvisionedNkeys

if TYPE_CHECKING:
    from synadia_ai.agent_service import AgentService


class WorkbookServer(Protocol):
    url: str
    identities: ProvisionedNkeys


async def test_python_sender_identity_end_to_end(  # noqa: PLR0915 — one topology, one walk
    workbook_server: WorkbookServer,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    echo_user = await connect_user(
        workbook_server.url, workbook_server.identities.user("echo").seed_path
    )
    hello_user = await connect_user(
        workbook_server.url, workbook_server.identities.user("hello").seed_path
    )
    cli_user = await connect_user(
        workbook_server.url, workbook_server.identities.user("cli").seed_path
    )
    echo: AgentService | None = None
    hello: AgentService | None = None
    seen_senders: list[SenderInfo | None] = []
    try:
        echo = await start_echo(echo_user.nc, echo_user.signer, seen_senders=seen_senders)
        hello = await start_hello(hello_user.nc, hello_user.signer)

        echo_id = AgentId.new("$G", echo_user.signer.public_key)
        hello_id = AgentId.new("$G", hello_user.signer.public_key)
        cli_id = AgentId.new("$G", cli_user.signer.public_key)
        assert len({echo_id, hello_id, cli_id}) == 3
        assert echo.identity == echo_id
        assert hello.identity == hello_id
        assert echo.min_sender_trust == "any"
        assert hello.min_sender_trust == "any"

        # Hello is not merely a caller: its own AgentService registration is
        # independently discoverable, identity-bearing, and signature-verified.
        inspector = Agents(nc=cli_user.nc, identity=Identity(signer=cli_user.signer))
        try:
            assert await inspector.self_id() == cli_id
            found_hello = await inspector.discover(
                timeout=1.0,
                filter=DiscoverFilter(agent="hello", owner=OWNER, session_name=SESSION_NAME),
            )
            assert len(found_hello) == 1
            assert found_hello[0].identity == hello_id
            assert found_hello[0].id_sig_verified is True
            assert found_hello[0].min_sender_trust == "any"
        finally:
            await inspector.close()

        hello_call = await call_echo_as_hello(hello_user.nc, hello_user.signer)
        assert hello_call.hello_identity == hello_id
        assert hello_call.echo_identity == echo_id
        assert hello_call.echo_id_sig_verified is True
        assert hello_call.response == "hello"
        assert len(seen_senders) == 1
        hello_sender = seen_senders[0]
        assert isinstance(hello_sender, VerifiedSender)
        assert hello_sender.id == hello_id

        no_identity_call = await call_echo(cli_user.nc, None, "hello without identity")
        assert no_identity_call.caller_identity is None
        assert no_identity_call.echo_identity == echo_id
        assert no_identity_call.echo_id_sig_verified is True
        assert no_identity_call.response == "hello without identity"
        assert len(seen_senders) == 2
        assert seen_senders[1] is None

        cli_call = await call_echo(cli_user.nc, cli_user.signer, "hello from CLI")
        assert cli_call.caller_identity == cli_id
        assert cli_call.echo_identity == echo_id
        assert cli_call.echo_id_sig_verified is True
        assert cli_call.response == "hello from CLI"
        assert len(seen_senders) == 3
        cli_sender = seen_senders[2]
        assert isinstance(cli_sender, VerifiedSender)
        assert cli_sender.id == cli_id

        echo_logs = [
            record.getMessage()
            for record in caplog.records
            if record.name == "identity_workbook.echo"
        ]
        assert any(f"Echo identity={echo_id}" in message for message in echo_logs)
        incoming_logs = [message for message in echo_logs if message.startswith("incoming sender=")]
        assert len(incoming_logs) == 3
        assert str(hello_id) in incoming_logs[0]
        assert incoming_logs[1] == "incoming sender=(no sender)"
        assert str(cli_id) in incoming_logs[2]
        assert "verified user" in incoming_logs[0]
        assert "verified user" in incoming_logs[2]
    finally:
        if hello is not None:
            await hello.stop()
        if echo is not None:
            await echo.stop()
        await cli_user.close()
        await hello_user.close()
        await echo_user.close()

"""End-to-end proof for the workbook's Echo, Hello, and CLI identities."""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack
from typing import Protocol

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
from call_echo import call_agent
from echo_agent import start_echo
from hello_agent import start_hello
from prepare_nkeys import ProvisionedNkeys


class WorkbookServer(Protocol):
    url: str
    identities: ProvisionedNkeys


async def test_python_sender_identity_end_to_end(  # noqa: PLR0915 — one topology, one walk
    workbook_server: WorkbookServer,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    async with AsyncExitStack() as stack:
        echo_user = await connect_user(
            workbook_server.url, workbook_server.identities.user("echo").seed_path
        )
        stack.push_async_callback(echo_user.close)
        hello_user = await connect_user(
            workbook_server.url, workbook_server.identities.user("hello").seed_path
        )
        stack.push_async_callback(hello_user.close)
        cli_user = await connect_user(
            workbook_server.url, workbook_server.identities.user("cli").seed_path
        )
        stack.push_async_callback(cli_user.close)

        echo_senders: list[SenderInfo | None] = []
        hello_senders: list[SenderInfo | None] = []
        echo = await start_echo(echo_user.nc, echo_user.signer, seen_senders=echo_senders)
        stack.push_async_callback(echo.stop)
        hello = await start_hello(
            hello_user.nc,
            hello_user.signer,
            seen_senders=hello_senders,
        )
        stack.push_async_callback(hello.stop)

        echo_id = AgentId.new("$G", echo_user.signer.public_key)
        hello_id = AgentId.new("$G", hello_user.signer.public_key)
        cli_id = AgentId.new("$G", cli_user.signer.public_key)
        assert len({echo_id, hello_id, cli_id}) == 3
        assert echo.identity == echo_id
        assert hello.service.identity == hello_id
        assert echo.min_sender_trust == "any"
        assert hello.service.min_sender_trust == "any"

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

        # The signed CLI prompts Hello. Hello receives the verified CLI sender,
        # prefixes the prompt, and forwards it to Echo under Hello's identity.
        hello_call = await call_agent(
            cli_user.nc,
            cli_user.signer,
            "identity workbook",
            agent_name="hello",
        )
        assert hello_call.caller_identity == cli_id
        assert hello_call.target_identity == hello_id
        assert hello_call.target_id_sig_verified is True
        assert hello_call.response == "Hello! identity workbook"

        assert len(hello_senders) == 1
        cli_to_hello_sender = hello_senders[0]
        assert isinstance(cli_to_hello_sender, VerifiedSender)
        assert cli_to_hello_sender.id == cli_id

        assert len(echo_senders) == 1
        hello_to_echo_sender = echo_senders[0]
        assert isinstance(hello_to_echo_sender, VerifiedSender)
        assert hello_to_echo_sender.id == hello_id

        # Hello also accepts a caller without Agent-Sender. Its outbound hop
        # is still signed as Hello, independent of the incoming trust level.
        anonymous_hello_call = await call_agent(
            cli_user.nc,
            None,
            "anonymous",
            agent_name="hello",
        )
        assert anonymous_hello_call.caller_identity is None
        assert anonymous_hello_call.target_identity == hello_id
        assert anonymous_hello_call.target_id_sig_verified is True
        assert anonymous_hello_call.response == "Hello! anonymous"
        assert len(hello_senders) == 2
        assert hello_senders[1] is None
        assert len(echo_senders) == 2
        anonymous_hop_sender = echo_senders[1]
        assert isinstance(anonymous_hop_sender, VerifiedSender)
        assert anonymous_hop_sender.id == hello_id

        no_identity_call = await call_agent(cli_user.nc, None, "hello without identity")
        assert no_identity_call.caller_identity is None
        assert no_identity_call.target_identity == echo_id
        assert no_identity_call.target_id_sig_verified is True
        assert no_identity_call.response == "hello without identity"
        assert len(echo_senders) == 3
        assert echo_senders[2] is None

        cli_call = await call_agent(cli_user.nc, cli_user.signer, "hello from CLI")
        assert cli_call.caller_identity == cli_id
        assert cli_call.target_identity == echo_id
        assert cli_call.target_id_sig_verified is True
        assert cli_call.response == "hello from CLI"
        assert len(echo_senders) == 4
        cli_sender = echo_senders[3]
        assert isinstance(cli_sender, VerifiedSender)
        assert cli_sender.id == cli_id

        echo_logs = [
            record.getMessage()
            for record in caplog.records
            if record.name == "identity_workbook.echo"
        ]
        assert any(f"Echo identity={echo_id}" in message for message in echo_logs)
        incoming_logs = [message for message in echo_logs if message.startswith("incoming sender=")]
        assert len(incoming_logs) == 4
        assert str(hello_id) in incoming_logs[0]
        assert str(hello_id) in incoming_logs[1]
        assert incoming_logs[2] == "incoming sender=(unknown sender)"
        assert str(cli_id) in incoming_logs[3]
        assert "verified user" in incoming_logs[0]
        assert "verified user" in incoming_logs[1]
        assert "verified user" in incoming_logs[3]

        hello_logs = [
            record.getMessage()
            for record in caplog.records
            if record.name == "identity_workbook.hello"
        ]
        assert any(f"Hello identity={hello_id}" in message for message in hello_logs)
        assert any(
            message.startswith("incoming sender=")
            and str(cli_id) in message
            and "verified user" in message
            for message in hello_logs
        )
        assert "incoming sender=(unknown sender)" in hello_logs
        assert any(
            f"discovered Echo identity={echo_id} id_sig_verified=True" == message
            for message in hello_logs
        )
        assert any(
            f"outgoing prompt identity={hello_id}" in message
            and f"recipient={echo_id}" in message
            and "prompt='Hello! identity workbook'" in message
            for message in hello_logs
        )
        assert "Echo replied='Hello! identity workbook'" in hello_logs
        assert "Echo replied='Hello! anonymous'" in hello_logs

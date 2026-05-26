from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, cast

import pytest
from synadia_ai.agents import Attachment, Envelope, ProtocolError

from synadia_ai.nats_deerflow_channel import host as host_module
from synadia_ai.nats_deerflow_channel.config import ChannelConfig, resolve_config
from synadia_ai.nats_deerflow_channel.host import (
    _nats_connect_options,
    build_agent_service,
    make_deerflow_prompt_handler,
    make_prompt_handler,
)
from synadia_ai.nats_deerflow_channel.runner import ClarificationEvent, TextEvent
from synadia_ai.nats_deerflow_channel.testing import fake_deerflow_runner


@pytest.mark.asyncio
async def test_fake_runner_yields_deterministic_chunks() -> None:
    chunks = [chunk async for chunk in fake_deerflow_runner("hello")]

    assert chunks == ["DeerFlow fake runner received: ", "hello"]


@pytest.mark.asyncio
async def test_prompt_handler_sends_runner_chunks() -> None:
    sent: list[str] = []

    async def runner(prompt: str) -> AsyncIterator[str]:
        yield f"one:{prompt}"
        yield "two"

    class Stream:
        async def send(self, chunk: str) -> None:
            sent.append(chunk)

    class Envelope:
        prompt = "hello"

    handler = make_prompt_handler(runner)
    await handler(cast(Any, Envelope()), cast(Any, Stream()))

    assert sent == ["one:hello", "two"]


def test_connect_options_use_direct_url(tmp_path: Path, monkeypatch: Any) -> None:
    monkeypatch.delenv("NATS_CONTEXT", raising=False)
    monkeypatch.setenv("NATS_URL", "nats://127.0.0.1:4222")
    config = resolve_config(config_file=tmp_path / "missing.toml")

    options = _nats_connect_options(config)

    assert options == {"servers": "nats://127.0.0.1:4222"}


def test_build_agent_service_requires_owner(tmp_path: Path) -> None:
    config = resolve_config(config_file=tmp_path / "missing.toml")

    with pytest.raises(ValueError, match="owner is required"):
        build_agent_service(config, nc=object())  # type: ignore[arg-type]


def test_build_agent_service_passes_hardening_metadata() -> None:
    config = ChannelConfig(owner="rene", max_payload="256KB")

    service = build_agent_service(config, nc=object())  # type: ignore[arg-type]

    assert service._attachments_ok is True
    assert service._max_payload == "256KB"


@pytest.mark.asyncio
async def test_deerflow_handler_rejects_unsafe_attachment_filename_before_gateway() -> None:
    class Stream:
        async def send(self, chunk: str) -> None:
            raise AssertionError("handler must reject before streaming")

    handler = make_deerflow_prompt_handler(ChannelConfig(owner="rene"))
    envelope = Envelope(
        prompt="hi",
        attachments=[Attachment(filename="../x.txt", content="aGk=")],
    )

    with pytest.raises(ProtocolError, match="unsafe attachment filename"):
        await handler(envelope, cast(Any, Stream()))


@pytest.mark.asyncio
async def test_deerflow_handler_forwards_query_reply_attachments(monkeypatch: Any) -> None:
    calls: list[tuple[str, list[Attachment] | None]] = []

    class FakeClient:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def stream_events(
            self,
            prompt: str,
            *,
            attachments: list[Attachment] | None = None,
        ) -> AsyncIterator[ClarificationEvent | TextEvent]:
            calls.append((prompt, attachments))
            if len(calls) == 1:
                yield ClarificationEvent("Which file?")
            else:
                yield TextEvent("done")

        async def aclose(self) -> None:
            pass

    class Stream:
        async def send(self, chunk: str) -> None:
            assert chunk == "done"

        async def ask(self, prompt: str, *, timeout: float) -> Envelope:
            assert prompt == "Which file?"
            assert timeout == 300
            return Envelope(
                prompt="use the follow-up file",
                attachments=[Attachment.from_bytes("reply.txt", b"reply")],
            )

    monkeypatch.setattr(host_module, "DeerFlowGatewayClient", FakeClient)
    handler = make_deerflow_prompt_handler(ChannelConfig(owner="rene"))

    await handler(
        Envelope(prompt="start", attachments=[Attachment.from_bytes("initial.txt", b"initial")]),
        cast(Any, Stream()),
    )

    assert calls == [
        ("start", [Attachment.from_bytes("initial.txt", b"initial")]),
        ("use the follow-up file", [Attachment.from_bytes("reply.txt", b"reply")]),
    ]


@pytest.mark.asyncio
async def test_deerflow_handler_rejects_unsafe_query_reply_attachment(monkeypatch: Any) -> None:
    class FakeClient:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        async def stream_events(
            self,
            prompt: str,
            *,
            attachments: list[Attachment] | None = None,
        ) -> AsyncIterator[ClarificationEvent]:
            yield ClarificationEvent("Need a file")

        async def aclose(self) -> None:
            pass

    class Stream:
        async def send(self, chunk: str) -> None:
            raise AssertionError("handler should reject before second turn")

        async def ask(self, prompt: str, *, timeout: float) -> Envelope:
            return Envelope(
                prompt="bad reply",
                attachments=[Attachment.from_bytes("../secret.txt", b"reply")],
            )

    monkeypatch.setattr(host_module, "DeerFlowGatewayClient", FakeClient)
    handler = make_deerflow_prompt_handler(ChannelConfig(owner="rene"))

    with pytest.raises(ProtocolError, match="unsafe attachment filename"):
        await handler(Envelope(prompt="start"), cast(Any, Stream()))

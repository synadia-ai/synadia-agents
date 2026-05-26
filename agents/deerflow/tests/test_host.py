from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, cast

import pytest
from synadia_ai.agents import Attachment, Envelope, ProtocolError

from synadia_ai.nats_deerflow_channel.config import ChannelConfig, resolve_config
from synadia_ai.nats_deerflow_channel.host import (
    _nats_connect_options,
    build_agent_service,
    make_deerflow_prompt_handler,
    make_prompt_handler,
)
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

    assert service._attachments_ok is False
    assert service._max_payload == "256KB"


@pytest.mark.asyncio
async def test_deerflow_handler_rejects_attachments_before_gateway() -> None:
    class Stream:
        async def send(self, chunk: str) -> None:
            raise AssertionError("handler must reject before streaming")

    handler = make_deerflow_prompt_handler(ChannelConfig(owner="rene"))
    envelope = Envelope(
        prompt="hi",
        attachments=[Attachment(filename="x.txt", content="aGk=")],
    )

    with pytest.raises(ProtocolError, match="attachments are not supported"):
        await handler(envelope, cast(Any, Stream()))

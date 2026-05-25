from __future__ import annotations

from typing import Any

import httpx
import pytest

from synadia_ai.nats_deerflow_channel.config import ChannelConfig
from synadia_ai.nats_deerflow_channel.runner import (
    ClarificationEvent,
    DeerFlowGatewayClient,
    DeerFlowGatewayError,
    TextEvent,
    _extract_clarification_from_sse_event,
    _extract_text_from_sse_event,
    deerflow_gateway_runner,
)


@pytest.mark.asyncio
async def test_gateway_runner_posts_prompt_to_deerflow_stream() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["json"] = request.read().decode()
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=(
                'event: messages\n'
                'data: [[{"type":"ai","content":"hello"}],{}]\n\n'
                'event: messages\n'
                'data: [[{"type":"ai","content":" world"}],{}]\n\n'
                'event: end\n'
                'data: null\n\n'
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", session="deerflow", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        chunks = [chunk async for chunk in client.stream_prompt("hi")]

    assert chunks == ["hello", " world"]
    assert seen["method"] == "POST"
    assert seen["path"] == "/api/threads/deerflow/runs/stream"
    assert '"content":"hi"' in seen["json"].replace(" ", "")
    assert '"stream_mode":["messages"]' in seen["json"].replace(" ", "")


@pytest.mark.asyncio
async def test_gateway_runner_raises_clear_error_for_non_2xx_stream() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="not ready")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        with pytest.raises(DeerFlowGatewayError, match="DeerFlow Gateway stream failed: 503"):
            _ = [chunk async for chunk in client.stream_prompt("hi")]


@pytest.mark.asyncio
async def test_gateway_runner_sanitizes_non_2xx_detail() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="first line\nsecond line" + ("x" * 600))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        with pytest.raises(DeerFlowGatewayError) as err:
            _ = [chunk async for chunk in client.stream_prompt("hi")]

    message = str(err.value)
    assert "first line | second line" in message
    assert "\n" not in message
    assert len(message) < 560


@pytest.mark.asyncio
async def test_gateway_reachability_uses_health_endpoint() -> None:
    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        return httpx.Response(200, json={"status": "healthy"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        assert await client.check_reachable() is True

    assert seen_paths == ["/health"]


def test_extract_text_from_langgraph_sse_shapes() -> None:
    assert _extract_text_from_sse_event("messages", [[{"content": "hello"}], {}]) == "hello"
    assert _extract_text_from_sse_event("messages", [{"content": "hi"}, {}]) == "hi"
    updates_event = {"agent": {"messages": [{"content": "done"}]}}
    assert _extract_text_from_sse_event("updates", updates_event) == "done"
    assert _extract_text_from_sse_event("metadata", {"run_id": "r"}) is None


def test_extract_clarification_tool_message_from_deerflow_sse() -> None:
    event = {
        "messages": [
            {
                "type": "tool",
                "name": "ask_clarification",
                "content": "❓ Which dataset should I use?",
            }
        ]
    }

    assert (
        _extract_clarification_from_sse_event("updates", event)
        == "❓ Which dataset should I use?"
    )
    assert _extract_text_from_sse_event("updates", event) is None


@pytest.mark.asyncio
async def test_gateway_stream_events_surfaces_clarification() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=(
                'event: updates\n'
                'data: {"messages":[{"type":"tool",'
                '"name":"ask_clarification","content":"Need input?"}]}\n\n'
                'event: end\n'
                'data: null\n\n'
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", session="deerflow", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        events = [event async for event in client.stream_events("hi")]

    assert events == [ClarificationEvent(prompt="Need input?")]


@pytest.mark.asyncio
async def test_gateway_stream_events_preserves_text_event_type() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content='event: messages\ndata: [[{"content":"ok"}],{}]\n\nevent: end\ndata: null\n\n',
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", session="deerflow", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        events = [event async for event in client.stream_events("hi")]

    assert events == [TextEvent(text="ok")]


@pytest.mark.asyncio
async def test_deerflow_gateway_runner_builds_client_from_config() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content='event: messages\ndata: [[{"content":"ok"}],{}]\n\nevent: end\ndata: null\n\n',
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        chunks = [
            chunk
            async for chunk in deerflow_gateway_runner(
                "hi",
                ChannelConfig(owner="rene", deerflow_url="http://deerflow.test"),
                http_client=http,
            )
        ]

    assert chunks == ["ok"]

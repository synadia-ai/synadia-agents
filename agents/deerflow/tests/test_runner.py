from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from synadia_ai.agents import Attachment, ProtocolError

from synadia_ai.nats_deerflow_channel.config import ChannelConfig
from synadia_ai.nats_deerflow_channel.runner import (
    ClarificationEvent,
    DeerFlowGatewayClient,
    DeerFlowGatewayError,
    TextEvent,
    ToolEvent,
    _extract_clarification_from_sse_event,
    _extract_events_from_sse_event,
    _extract_text_from_sse_event,
    _extract_tool_status_from_sse_event,
    deerflow_gateway_runner,
)


@pytest.mark.asyncio
async def test_gateway_runner_posts_prompt_to_deerflow_stream() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/threads":
            seen["thread_body"] = request.read().decode()
            return httpx.Response(200, json={"thread_id": "deerflow", "status": "idle"})
        seen["method"] = request.method
        seen["path"] = request.url.path
        seen["json"] = request.read().decode()
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=(
                "event: messages\n"
                'data: [[{"type":"ai","content":"hello"}],{}]\n\n'
                "event: messages\n"
                'data: [[{"type":"ai","content":" world"}],{}]\n\n'
                "event: end\n"
                "data: null\n\n"
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", session="deerflow", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        chunks = [chunk async for chunk in client.stream_prompt("hi")]

    assert chunks == ["hello", " world"]
    assert '"thread_id":"deerflow"' in seen["thread_body"].replace(" ", "")
    assert seen["method"] == "POST"
    assert seen["path"] == "/api/threads/deerflow/runs/stream"
    stream_body = json.loads(seen["json"])
    message = stream_body["input"]["messages"][0]
    assert message["type"] == "human"
    assert message["content"] == [{"type": "text", "text": "hi"}]
    assert '"stream_mode":["messages"]' in seen["json"].replace(" ", "")


@pytest.mark.asyncio
async def test_gateway_runner_uploads_attachments_and_includes_virtual_paths_in_prompt() -> None:
    seen: dict[str, Any] = {"paths": []}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["paths"].append(request.url.path)
        if request.url.path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "deerflow", "status": "idle"})
        if request.url.path == "/api/threads/deerflow/uploads":
            body = request.read()
            seen["upload_content_type"] = request.headers.get("content-type")
            seen["upload_body"] = body
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "files": [
                        {
                            "filename": "brief.txt",
                            "size": 15,
                            "virtual_path": "/mnt/user-data/uploads/brief.txt",
                            "path": "/sandbox/uploads/brief.txt",
                            "artifact_url": (
                                "/api/threads/deerflow/artifacts/mnt/user-data/uploads/brief.txt"
                            ),
                        }
                    ],
                    "message": "Successfully uploaded 1 file(s)",
                    "skipped_files": [],
                },
            )
        seen["stream_json"] = request.read().decode()
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content='event: messages\ndata: [[{"type":"ai","content":"ok"}],{}]\n\n',
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", session="deerflow", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        chunks = [
            chunk
            async for chunk in client.stream_prompt(
                "read it",
                attachments=[Attachment.from_bytes("brief.txt", b"attachment text")],
            )
        ]

    assert chunks == ["ok"]
    assert seen["paths"] == [
        "/api/threads",
        "/api/threads/deerflow/uploads",
        "/api/threads/deerflow/runs/stream",
    ]
    assert str(seen["upload_content_type"]).startswith("multipart/form-data")
    assert b'filename="brief.txt"' in seen["upload_body"]
    assert b"attachment text" in seen["upload_body"]
    stream_body = json.loads(seen["stream_json"])
    message = stream_body["input"]["messages"][0]
    assert message["type"] == "human"
    assert message["content"] == [{"type": "text", "text": "read it"}]
    assert message["additional_kwargs"]["files"] == [
        {
            "filename": "brief.txt",
            "path": "/mnt/user-data/uploads/brief.txt",
            "status": "uploaded",
            "size": 15,
            "artifact_url": "/api/threads/deerflow/artifacts/mnt/user-data/uploads/brief.txt",
        }
    ]


@pytest.mark.asyncio
async def test_gateway_runner_url_escapes_thread_path_segments() -> None:
    seen_raw_paths: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_raw_paths.append(request.url.raw_path)
        if request.url.path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "space session/one", "status": "idle"})
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content='event: messages\ndata: [[{"type":"ai","content":"ok"}],{}]\n\n',
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(
                owner="rene",
                session="space session/one",
                deerflow_url="http://deerflow.test",
            ),
            http_client=http,
        )
        chunks = [chunk async for chunk in client.stream_prompt("hi")]

    assert chunks == ["ok"]
    assert seen_raw_paths == [b"/api/threads", b"/api/threads/space%20session%2Fone/runs/stream"]


@pytest.mark.asyncio
async def test_gateway_runner_rejects_skipped_uploads_before_stream() -> None:
    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        if request.url.path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "deerflow", "status": "idle"})
        if request.url.path == "/api/threads/deerflow/uploads":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "files": [],
                    "skipped_files": [{"filename": "too-big.pdf", "reason": "too large"}],
                },
            )
        raise AssertionError("stream should not be called after skipped upload")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", session="deerflow", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        with pytest.raises(ProtocolError, match="skipped"):
            _ = [
                chunk
                async for chunk in client.stream_prompt(
                    "read it",
                    attachments=[Attachment.from_bytes("too-big.pdf", b"x")],
                )
            ]

    assert seen_paths == ["/api/threads", "/api/threads/deerflow/uploads"]


@pytest.mark.asyncio
async def test_gateway_runner_maps_4xx_upload_failure_to_protocol_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "deerflow", "status": "idle"})
        if request.url.path == "/api/threads/deerflow/uploads":
            return httpx.Response(400, text="bad file")
        raise AssertionError("stream should not be called after upload failure")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", session="deerflow", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        with pytest.raises(ProtocolError, match="upload failed: 400"):
            _ = [
                chunk
                async for chunk in client.stream_prompt(
                    "read it",
                    attachments=[Attachment.from_bytes("brief.txt", b"x")],
                )
            ]


@pytest.mark.asyncio
async def test_gateway_runner_maps_invalid_attachment_base64_to_protocol_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"HTTP should not be called with invalid base64: {request.url.path}")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", session="deerflow", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        with pytest.raises(ProtocolError, match="invalid base64"):
            _ = [
                chunk
                async for chunk in client.stream_prompt(
                    "read it",
                    attachments=[Attachment(filename="brief.txt", content="not valid base64")],
                )
            ]


@pytest.mark.asyncio
async def test_gateway_runner_sends_deerflow_auth_headers() -> None:
    seen: dict[str, str | None] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["csrf"] = request.headers.get("X-CSRF-Token")
        seen["cookie"] = request.headers.get("Cookie")
        if request.url.path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "default", "status": "idle"})
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content='event: messages\ndata: [[{"type":"ai","content":"ok"}],{}]\n\n',
        )

    config = ChannelConfig(
        deerflow_url="http://deerflow.local",
        deerflow_cookie="access_token=session; csrf_token=csrf-123",
        deerflow_csrf_token="csrf-123",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        chunks = [
            chunk
            async for chunk in deerflow_gateway_runner(
                "question?",
                config,
                http_client=http,
            )
        ]
        result = "".join(chunks)

    assert result == "ok"
    assert seen["csrf"] == "csrf-123"
    assert seen["cookie"] == "access_token=session; csrf_token=csrf-123"


@pytest.mark.asyncio
async def test_gateway_runner_can_login_and_use_csrf_cookie() -> None:
    seen: dict[str, Any] = {"paths": []}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["paths"].append(request.url.path)
        if request.url.path == "/api/v1/auth/login/local":
            seen["login_body"] = request.read().decode()
            return httpx.Response(
                200,
                headers=[
                    ("set-cookie", "access_token=session-token; Path=/"),
                    ("set-cookie", "csrf_token=csrf-from-login; Path=/"),
                ],
                json={"expires_in": 3600, "needs_setup": False},
            )
        seen["csrf"] = request.headers.get("X-CSRF-Token")
        seen["cookie"] = request.headers.get("Cookie")
        if request.url.path == "/api/threads":
            seen["thread_body"] = request.read().decode()
            return httpx.Response(200, json={"thread_id": "default", "status": "idle"})
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content='event: messages\ndata: [[{"type":"ai","content":"ok"}],{}]\n\n',
        )

    config = ChannelConfig(
        deerflow_url="http://deerflow.local",
        deerflow_username="rene@example.com",
        deerflow_password="secret",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        chunks = [
            chunk
            async for chunk in deerflow_gateway_runner(
                "question?",
                config,
                http_client=http,
            )
        ]

    assert chunks == ["ok"]
    assert seen["paths"] == [
        "/api/v1/auth/login/local",
        "/api/threads",
        "/api/threads/default/runs/stream",
    ]
    assert '"thread_id":"default"' in seen["thread_body"].replace(" ", "")
    assert "username=rene%40example.com" in seen["login_body"]
    assert "password=secret" in seen["login_body"]
    assert seen["csrf"] == "csrf-from-login"
    assert "access_token=session-token" in seen["cookie"]
    assert "csrf_token=csrf-from-login" in seen["cookie"]


@pytest.mark.asyncio
async def test_gateway_runner_uploads_attachments_with_login_csrf_headers() -> None:
    seen: dict[str, Any] = {"paths": [], "csrf_by_path": {}, "cookie_by_path": {}}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        seen["paths"].append(path)
        if path == "/api/v1/auth/login/local":
            return httpx.Response(
                200,
                headers=[
                    ("set-cookie", "access_token=session-token; Path=/"),
                    ("set-cookie", "csrf_token=csrf-from-login; Path=/"),
                ],
                json={"expires_in": 3600, "needs_setup": False},
            )
        seen["csrf_by_path"][path] = request.headers.get("X-CSRF-Token")
        seen["cookie_by_path"][path] = request.headers.get("Cookie")
        if path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "default", "status": "idle"})
        if path == "/api/threads/default/uploads":
            assert b'filename="brief.txt"' in request.read()
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "files": [
                        {
                            "filename": "brief.txt",
                            "virtual_path": "/mnt/user-data/uploads/brief.txt",
                        }
                    ],
                    "skipped_files": [],
                },
            )
        if path == "/api/threads/default/runs/stream":
            seen["stream_body"] = json.loads(request.read())
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content='event: messages\ndata: [[{"type":"ai","content":"ok"}],{}]\n\n',
            )
        raise AssertionError(f"unexpected request: {path}")

    config = ChannelConfig(
        deerflow_url="http://deerflow.local",
        deerflow_username="rene@example.com",
        deerflow_password="secret",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        chunks = [
            chunk
            async for chunk in deerflow_gateway_runner(
                "question?",
                config,
                http_client=http,
                attachments=[Attachment.from_bytes("brief.txt", b"attachment text")],
            )
        ]

    assert chunks == ["ok"]
    assert seen["paths"] == [
        "/api/v1/auth/login/local",
        "/api/threads",
        "/api/threads/default/uploads",
        "/api/threads/default/runs/stream",
    ]
    for path in [
        "/api/threads",
        "/api/threads/default/uploads",
        "/api/threads/default/runs/stream",
    ]:
        assert seen["csrf_by_path"][path] == "csrf-from-login"
        assert "access_token=session-token" in seen["cookie_by_path"][path]
        assert "csrf_token=csrf-from-login" in seen["cookie_by_path"][path]
    message = seen["stream_body"]["input"]["messages"][0]
    assert message["additional_kwargs"]["files"] == [
        {
            "filename": "brief.txt",
            "path": "/mnt/user-data/uploads/brief.txt",
            "status": "uploaded",
        }
    ]


@pytest.mark.asyncio
async def test_gateway_client_reuses_owned_http_client_for_cookie_persistence() -> None:
    client = DeerFlowGatewayClient(ChannelConfig(deerflow_url="http://deerflow.test"))
    async with client._client() as first:
        first.cookies.set("csrf_token", "csrf-one", domain="deerflow.test")
    async with client._client() as second:
        assert second is first
        assert second.cookies.get("csrf_token") == "csrf-one"
    await client.aclose()


@pytest.mark.asyncio
async def test_gateway_runner_treats_existing_thread_conflict_as_success() -> None:
    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        if request.url.path == "/api/threads":
            return httpx.Response(409, text="thread already exists")
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content='event: messages\ndata: [[{"type":"ai","content":"ok"}],{}]\n\n',
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", session="deerflow", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        chunks = [chunk async for chunk in client.stream_prompt("hi")]

    assert chunks == ["ok"]
    assert seen_paths == ["/api/threads", "/api/threads/deerflow/runs/stream"]


@pytest.mark.asyncio
async def test_gateway_runner_raises_clear_error_for_non_2xx_stream() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "default", "status": "idle"})
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
        if request.url.path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "default", "status": "idle"})
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
    assert (
        _extract_text_from_sse_event("messages", [[{"type": "ai", "content": "hello"}], {}])
        == "hello"
    )
    assert _extract_text_from_sse_event("messages", [{"type": "ai", "content": "hi"}, {}]) == "hi"
    updates_event = {"agent": {"messages": [{"type": "AIMessage", "content": "done"}]}}
    assert _extract_text_from_sse_event("updates", updates_event) == "done"
    assert _extract_text_from_sse_event("metadata", {"run_id": "r"}) is None


def test_extract_text_ignores_non_assistant_langgraph_noise() -> None:
    assert _extract_text_from_sse_event("messages", ["branch:to:model", {}]) is None
    assert _extract_text_from_sse_event("updates", {"agent": ["branch:to:model"]}) is None
    assert (
        _extract_text_from_sse_event(
            "messages",
            [
                {
                    "type": "human",
                    "content": "Give me a two sentence summary of what DeerFlow is.",
                },
                {"langgraph_node": "agent"},
            ],
        )
        is None
    )
    assert (
        _extract_text_from_sse_event(
            "messages",
            [
                {
                    "type": "AIMessageChunk",
                    "content": "",
                    "response_metadata": {"model_name": "openai", "finish_reason": "stop"},
                    "usage_metadata": {"output_token_details": "tool_calls"},
                },
                {"message_class": "AIMessageChunk", "langgraph_node": "agent"},
            ],
        )
        is None
    )
    assert (
        _extract_text_from_sse_event("messages", [{"debug": {"content": "internal"}}, {}]) is None
    )
    assert (
        _extract_text_from_sse_event(
            "values",
            {
                "messages": [{"type": "ai", "content": "visible"}],
                "debug": {"type": "ai", "content": "internal"},
                "response_metadata": {"model_name": "openai"},
            },
        )
        == "visible"
    )
    assert (
        _extract_clarification_from_sse_event(
            "values",
            {"metadata": {"name": "ask_clarification", "content": "hidden"}},
        )
        is None
    )


def test_extract_events_keeps_two_real_messages_from_one_sse_event() -> None:
    assert _extract_events_from_sse_event(
        "messages",
        [
            {"type": "ai", "content": "first"},
            {"type": "AIMessageChunk", "content": "second"},
        ],
    ) == [TextEvent(text="first"), TextEvent(text="second")]


def test_state_message_payloads_has_depth_guard() -> None:
    nested: dict[str, Any] = {"messages": [{"type": "ai", "content": "deep"}]}
    for _ in range(80):
        nested = {"nested": nested}

    assert _extract_text_from_sse_event("updates", nested) is None


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
        _extract_clarification_from_sse_event("updates", event) == "❓ Which dataset should I use?"
    )
    assert _extract_text_from_sse_event("updates", event) is None


@pytest.mark.asyncio
async def test_gateway_stream_events_surfaces_clarification() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "deerflow", "status": "idle"})
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=(
                "event: updates\n"
                'data: {"messages":[{"type":"tool",'
                '"name":"ask_clarification","content":"Need input?"}]}\n\n'
                "event: end\n"
                "data: null\n\n"
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
        if request.url.path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "deerflow", "status": "idle"})
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=(
                'event: messages\ndata: [[{"type":"AIMessageChunk","content":"ok"}],{}]\n\n'
                "event: end\ndata: null\n\n"
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", session="deerflow", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        events = [event async for event in client.stream_events("hi")]

    assert events == [TextEvent(text="ok")]


def test_extract_tool_status_handles_common_tool_call_shapes() -> None:
    assert (
        _extract_tool_status_from_sse_event(
            "messages",
            [
                {
                    "type": "AIMessageChunk",
                    "content": "",
                    "additional_kwargs": {"tool_calls": [{"function": {"name": "web_search"}}]},
                },
                {},
            ],
        )
        == "DeerFlow tool call: web_search"
    )
    assert (
        _extract_tool_status_from_sse_event(
            "messages",
            [
                {
                    "type": "AIMessageChunk",
                    "content": "",
                    "tool_calls": [{"function": {"name": "web search!?"}}],
                },
                {},
            ],
        )
        == "DeerFlow tool call: web_search"
    )
    assert (
        _extract_tool_status_from_sse_event(
            "messages",
            [{"type": "tool", "tool_call_id": "call_123", "content": "{}"}, {}],
        )
        == "DeerFlow tool result"
    )


@pytest.mark.asyncio
async def test_gateway_stream_events_surfaces_tool_activity_as_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "deerflow", "status": "idle"})
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=(
                "event: messages\n"
                'data: [[{"type":"AIMessageChunk","content":"",'
                '"tool_calls":[{"name":"web_search"}],'
                '"response_metadata":{"model_name":"openai"}}],{}]\n\n'
                "event: messages\n"
                'data: [[{"type":"tool","name":"web_search",'
                '"content":"{\\"query\\": \\"deerflow\\"}"}],{}]\n\n'
                "event: messages\n"
                'data: [[{"type":"AIMessageChunk","content":"answer"}],{}]\n\n'
                "event: end\n"
                "data: null\n\n"
            ),
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = DeerFlowGatewayClient(
            ChannelConfig(owner="rene", session="deerflow", deerflow_url="http://deerflow.test"),
            http_client=http,
        )
        events = [event async for event in client.stream_events("hi")]

    assert events == [
        ToolEvent(status="DeerFlow tool call: web_search"),
        ToolEvent(status="DeerFlow tool result: web_search"),
        TextEvent(text="answer"),
    ]


@pytest.mark.asyncio
async def test_deerflow_gateway_runner_builds_client_from_config() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/threads":
            return httpx.Response(200, json={"thread_id": "default", "status": "idle"})
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=(
                'event: messages\ndata: [[{"type":"AIMessageChunk","content":"ok"}],{}]\n\n'
                "event: end\ndata: null\n\n"
            ),
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

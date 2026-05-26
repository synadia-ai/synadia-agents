"""Prompt runners for the DeerFlow channel."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import httpx

from .config import ChannelConfig

HTTP_OK_MIN = 200
HTTP_OK_MAX = 300
MAX_ERROR_DETAIL_CHARS = 500


class DeerFlowGatewayError(RuntimeError):
    """Raised for operator-safe DeerFlow Gateway failures."""


def _safe_error_detail(detail: str) -> str:
    flat = " | ".join(line.strip() for line in detail.splitlines() if line.strip())
    if len(flat) > MAX_ERROR_DETAIL_CHARS:
        flat = flat[: MAX_ERROR_DETAIL_CHARS - 3] + "..."
    return flat


@dataclass(frozen=True)
class TextEvent:
    """Assistant-visible text emitted by DeerFlow."""

    text: str


@dataclass(frozen=True)
class ClarificationEvent:
    """DeerFlow ask_clarification tool message surfaced as a protocol query."""

    prompt: str


@dataclass(frozen=True)
class ToolEvent:
    """Meaningful DeerFlow tool activity surfaced as protocol status."""

    status: str


DeerFlowEvent = TextEvent | ClarificationEvent | ToolEvent


class DeerFlowGatewayClient:
    """Narrow async client for DeerFlow Gateway prompt streaming.

    This intentionally uses only the LangGraph-compatible DeerFlow Gateway
    surface the wrapper needs: health reachability and thread run SSE streams.
    Status and heartbeat subjects remain owned by the Synadia wrapper.
    """

    def __init__(
        self,
        config: ChannelConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
        timeout: float = 60.0,
    ) -> None:
        self._config = config
        self._http_client = http_client
        self._timeout = timeout
        self._logged_in = False

    async def check_reachable(self) -> bool:
        """Return whether DeerFlow Gateway's public health endpoint responds 2xx."""
        async with self._client() as client:
            try:
                response = await client.get(self._url("/health"))
            except httpx.HTTPError:
                return False
        return HTTP_OK_MIN <= response.status_code < HTTP_OK_MAX

    async def stream_events(self, prompt: str) -> AsyncIterator[DeerFlowEvent]:
        """POST a user prompt to DeerFlow Gateway and yield semantic stream events."""
        body = _prompt_request_body(prompt)
        path = f"/api/threads/{self._config.session}/runs/stream"
        async with self._client() as client:
            await self._ensure_authenticated(client)
            await self._ensure_thread_exists(client)
            async with client.stream(
                "POST",
                self._url(path),
                json=body,
                headers=self._request_headers(client),
            ) as response:
                if not HTTP_OK_MIN <= response.status_code < HTTP_OK_MAX:
                    body_bytes = await response.aread()
                    detail = _safe_error_detail(body_bytes.decode(errors="replace"))
                    suffix = f": {detail}" if detail else ""
                    raise DeerFlowGatewayError(
                        f"DeerFlow Gateway stream failed: {response.status_code}{suffix}"
                    )

                async for event, data in _iter_sse(response):
                    if event == "end":
                        break
                    clarification = _extract_clarification_from_sse_event(event, data)
                    if clarification:
                        yield ClarificationEvent(prompt=clarification)
                        continue
                    tool_status = _extract_tool_status_from_sse_event(event, data)
                    if tool_status:
                        yield ToolEvent(status=tool_status)
                        continue
                    text = _extract_text_from_sse_event(event, data)
                    if text:
                        yield TextEvent(text=text)

    async def stream_prompt(self, prompt: str) -> AsyncIterator[str]:
        """POST a user prompt to DeerFlow Gateway and yield text chunks from SSE."""
        async for event in self.stream_events(prompt):
            if isinstance(event, TextEvent):
                yield event.text

    def _client(self) -> _ClientContext:
        if self._http_client is not None:
            return _ClientContext(self._http_client, close=False)
        return _ClientContext(httpx.AsyncClient(timeout=self._timeout), close=True)

    def _url(self, path: str) -> str:
        return urljoin(self._config.deerflow_url.rstrip("/") + "/", path.lstrip("/"))

    async def _ensure_authenticated(self, client: httpx.AsyncClient) -> None:
        if not self._config.deerflow_username:
            return
        if self._logged_in and client.cookies.get("csrf_token"):
            return
        if not self._config.deerflow_password:
            raise DeerFlowGatewayError(
                "DeerFlow username was configured but DeerFlow password is missing"
            )
        response = await client.post(
            self._url("/api/v1/auth/login/local"),
            data={
                "username": self._config.deerflow_username,
                "password": self._config.deerflow_password,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if not HTTP_OK_MIN <= response.status_code < HTTP_OK_MAX:
            detail = _safe_error_detail(response.text)
            suffix = f": {detail}" if detail else ""
            raise DeerFlowGatewayError(
                f"DeerFlow Gateway login failed: {response.status_code}{suffix}"
            )
        self._logged_in = True

    async def _ensure_thread_exists(self, client: httpx.AsyncClient) -> None:
        response = await client.post(
            self._url("/api/threads"),
            json={
                "thread_id": self._config.session,
                "metadata": {"source": "synadia-nats-channel"},
            },
            headers=self._request_headers(client),
        )
        if not HTTP_OK_MIN <= response.status_code < HTTP_OK_MAX:
            detail = _safe_error_detail(response.text)
            suffix = f": {detail}" if detail else ""
            raise DeerFlowGatewayError(
                f"DeerFlow Gateway thread ensure failed: {response.status_code}{suffix}"
            )

    def _request_headers(self, client: httpx.AsyncClient) -> dict[str, str]:
        headers: dict[str, str] = {}
        cookie = self._config.deerflow_cookie
        csrf_token = self._config.deerflow_csrf_token or client.cookies.get("csrf_token")
        if csrf_token:
            headers["X-CSRF-Token"] = csrf_token
        if cookie:
            headers["Cookie"] = cookie
        return headers


class _ClientContext:
    def __init__(self, client: httpx.AsyncClient, *, close: bool) -> None:
        self._client = client
        self._close = close

    async def __aenter__(self) -> httpx.AsyncClient:
        return self._client

    async def __aexit__(self, *exc_info: object) -> None:
        if self._close:
            await self._client.aclose()


async def fake_deerflow_runner(prompt: str) -> AsyncIterator[str]:
    """Yield deterministic chunks for protocol-host tests."""
    yield "DeerFlow fake runner received: "
    yield prompt


async def deerflow_gateway_runner(
    prompt: str,
    config: ChannelConfig,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> AsyncIterator[str]:
    """Run one prompt through the configured DeerFlow Gateway."""
    client = DeerFlowGatewayClient(config, http_client=http_client)
    async for chunk in client.stream_prompt(prompt):
        yield chunk


def _prompt_request_body(prompt: str) -> dict[str, Any]:
    return {
        "assistant_id": "lead_agent",
        "input": {"messages": [{"role": "user", "content": prompt}]},
        "config": {"recursion_limit": 50},
        "context": {
            "mode": "flash",
            "thinking_enabled": False,
            "is_plan_mode": False,
            "subagent_enabled": False,
        },
        "stream_mode": ["messages"],
    }


async def _iter_sse(response: httpx.Response) -> AsyncIterator[tuple[str, Any]]:
    event = "message"
    data_lines: list[str] = []
    async for line in response.aiter_lines():
        if line == "":
            if data_lines:
                yield event, _parse_sse_data("\n".join(data_lines))
            event = "message"
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event = line.removeprefix("event:").strip()
            continue
        if line.startswith("data:"):
            data_lines.append(line.removeprefix("data:").lstrip())
    if data_lines:
        yield event, _parse_sse_data("\n".join(data_lines))


def _parse_sse_data(raw: str) -> Any:
    if raw == "":
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def _extract_clarification_from_sse_event(event: str, data: Any) -> str | None:
    """Extract DeerFlow ask_clarification tool text from SSE event data."""
    if event not in {"messages", "messages-tuple", "updates", "values"}:
        return None
    return _extract_clarification(data)


def _extract_tool_status_from_sse_event(event: str, data: Any) -> str | None:
    """Extract meaningful DeerFlow tool activity without leaking metadata noise."""
    if event not in {"messages", "messages-tuple", "updates", "values"}:
        return None
    return _extract_tool_status(data)


def _extract_tool_status(value: Any) -> str | None:  # noqa: PLR0911,PLR0912
    if isinstance(value, dict):
        tool_calls = value.get("tool_calls") or value.get("tool_call_chunks")
        status = _extract_tool_call_status(tool_calls)
        if status:
            return status

        name = value.get("name")
        message_type = value.get("type")
        if isinstance(name, str) and name and message_type == "tool":
            return f"DeerFlow tool result: {name}"
        if isinstance(name, str) and name and value.get("id", "").startswith("call_"):
            return f"DeerFlow tool call: {name}"

        for key in ("messages", "message"):
            status = _extract_tool_status(value.get(key))
            if status:
                return status
        for key, nested in value.items():
            if key in {"metadata", "response_metadata", "usage_metadata", "config"}:
                continue
            if isinstance(nested, dict | list):
                status = _extract_tool_status(nested)
                if status:
                    return status
    if isinstance(value, list):
        for item in value:
            status = _extract_tool_status(item)
            if status:
                return status
    return None


def _extract_tool_call_status(tool_calls: Any) -> str | None:
    if isinstance(tool_calls, dict):
        name = tool_calls.get("name")
        if isinstance(name, str) and name:
            return f"DeerFlow tool call: {name}"
    if isinstance(tool_calls, list):
        for item in tool_calls:
            status = _extract_tool_call_status(item)
            if status:
                return status
    return None


def _extract_clarification(value: Any) -> str | None:
    if isinstance(value, dict):
        if value.get("name") == "ask_clarification":
            content = value.get("content")
            if isinstance(content, str) and content:
                return content
        for key in ("messages", "message"):
            nested = value.get(key)
            clarification = _extract_clarification(nested)
            if clarification:
                return clarification
        for nested in value.values():
            clarification = _extract_clarification(nested)
            if clarification:
                return clarification
    if isinstance(value, list):
        for item in value:
            clarification = _extract_clarification(item)
            if clarification:
                return clarification
    return None


def _extract_text_from_sse_event(event: str, data: Any) -> str | None:
    """Extract assistant-visible text from LangGraph/DeerFlow SSE event data."""
    if event not in {"messages", "messages-tuple", "updates", "values"}:
        return None
    return _extract_text(data)


def _extract_text(value: Any) -> str | None:  # noqa: PLR0911,PLR0912
    if isinstance(value, str):
        return value or None
    if isinstance(value, dict):
        if value.get("name") == "ask_clarification":
            return None
        content = value.get("content")
        if isinstance(content, str) and content and _is_assistant_message(value):
            return content
        for key in ("messages", "message"):
            nested = value.get(key)
            text = _extract_text(nested)
            if text:
                return text
        for key, nested in value.items():
            if key in {"metadata", "response_metadata", "usage_metadata", "config"}:
                continue
            if isinstance(nested, dict | list):
                text = _extract_text(nested)
                if text:
                    return text
    if isinstance(value, list):
        for item in value:
            text = _extract_text(item)
            if text:
                return text
    return None


def _is_assistant_message(value: dict[str, Any]) -> bool:
    role = value.get("role")
    if isinstance(role, str):
        return role in {"assistant", "ai"}

    message_type = value.get("type")
    if isinstance(message_type, str):
        return message_type in {"ai", "assistant", "AIMessage", "AIMessageChunk"}

    # Some LangChain/LangGraph message chunks arrive as plain dicts with a
    # content field after serialization. Treat absent role/type as assistant
    # output, but reject known non-assistant payloads explicitly above.
    return True

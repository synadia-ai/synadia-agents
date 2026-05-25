"""Prompt runners for the DeerFlow channel."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urljoin

import httpx

from .config import ChannelConfig

HTTP_OK_MIN = 200
HTTP_OK_MAX = 300


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

    async def check_reachable(self) -> bool:
        """Return whether DeerFlow Gateway's public health endpoint responds 2xx."""
        async with self._client() as client:
            try:
                response = await client.get(self._url("/health"))
            except httpx.HTTPError:
                return False
        return HTTP_OK_MIN <= response.status_code < HTTP_OK_MAX

    async def stream_prompt(self, prompt: str) -> AsyncIterator[str]:
        """POST a user prompt to DeerFlow Gateway and yield text chunks from SSE."""
        body = _prompt_request_body(prompt)
        path = f"/api/threads/{self._config.session}/runs/stream"
        async with (
            self._client() as client,
            client.stream("POST", self._url(path), json=body) as response,
        ):
            if not HTTP_OK_MIN <= response.status_code < HTTP_OK_MAX:
                body_bytes = await response.aread()
                detail = body_bytes.decode(errors="replace").strip()
                suffix = f": {detail}" if detail else ""
                raise RuntimeError(
                    f"DeerFlow Gateway stream failed: {response.status_code}{suffix}"
                )

            async for event, data in _iter_sse(response):
                if event == "end":
                    break
                text = _extract_text_from_sse_event(event, data)
                if text:
                    yield text

    def _client(self) -> _ClientContext:
        if self._http_client is not None:
            return _ClientContext(self._http_client, close=False)
        return _ClientContext(httpx.AsyncClient(timeout=self._timeout), close=True)

    def _url(self, path: str) -> str:
        return urljoin(self._config.deerflow_url.rstrip("/") + "/", path.lstrip("/"))


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


def _extract_text_from_sse_event(event: str, data: Any) -> str | None:
    """Extract assistant-visible text from LangGraph/DeerFlow SSE event data."""
    if event not in {"messages", "messages-tuple", "updates", "values"}:
        return None
    return _extract_text(data)


def _extract_text(value: Any) -> str | None:
    if isinstance(value, str):
        return value or None
    if isinstance(value, dict):
        content = value.get("content")
        if isinstance(content, str) and content:
            return content
        for key in ("messages", "message"):
            nested = value.get(key)
            text = _extract_text(nested)
            if text:
                return text
        for nested in value.values():
            text = _extract_text(nested)
            if text:
                return text
    if isinstance(value, list):
        for item in value:
            text = _extract_text(item)
            if text:
                return text
    return None

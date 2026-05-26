"""Prompt runners for the DeerFlow channel."""

from __future__ import annotations

import binascii
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urljoin

import httpx
from pydantic import BaseModel
from synadia_ai.agents import Attachment, ProtocolError

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


class UploadedAttachment(BaseModel):
    """One file accepted by the DeerFlow Gateway upload API."""

    filename: str
    virtual_path: str
    size: int | None = None
    path: str | None = None
    artifact_url: str | None = None


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
        self._owned_http_client: httpx.AsyncClient | None = None
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

    async def stream_events(
        self,
        prompt: str,
        *,
        attachments: list[Attachment] | None = None,
    ) -> AsyncIterator[DeerFlowEvent]:
        """POST a user prompt to DeerFlow Gateway and yield semantic stream events."""
        path = f"/api/threads/{self._thread_id_path_segment()}/runs/stream"
        attachment_files = _attachment_files(attachments or [])
        async with self._client() as client:
            await self._ensure_authenticated(client)
            await self._ensure_thread_exists(client)
            uploaded = await self._upload_attachment_files(client, attachment_files)
            body = _prompt_request_body(prompt, uploaded_attachments=uploaded)
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
                    for semantic_event in _extract_events_from_sse_event(event, data):
                        yield semantic_event

    async def stream_prompt(
        self,
        prompt: str,
        *,
        attachments: list[Attachment] | None = None,
    ) -> AsyncIterator[str]:
        """POST a user prompt to DeerFlow Gateway and yield text chunks from SSE."""
        async for event in self.stream_events(prompt, attachments=attachments):
            if isinstance(event, TextEvent):
                yield event.text

    def _client(self) -> _ClientContext:
        if self._http_client is not None:
            return _ClientContext(self._http_client, close=False)
        if self._owned_http_client is None:
            self._owned_http_client = httpx.AsyncClient(timeout=self._timeout)
        return _ClientContext(self._owned_http_client, close=False)

    async def aclose(self) -> None:
        """Close the owned HTTP client, if this wrapper created one."""
        if self._owned_http_client is not None:
            await self._owned_http_client.aclose()
            self._owned_http_client = None
            self._logged_in = False

    def _url(self, path: str) -> str:
        return urljoin(self._config.deerflow_url.rstrip("/") + "/", path.lstrip("/"))

    def _thread_id_path_segment(self) -> str:
        return quote(self._config.session, safe="")

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

    async def _upload_attachment_files(
        self,
        client: httpx.AsyncClient,
        files: list[tuple[str, tuple[str, bytes]]],
    ) -> list[UploadedAttachment]:
        if not files:
            return []
        response = await client.post(
            self._url(f"/api/threads/{self._thread_id_path_segment()}/uploads"),
            files=files,
            headers=self._request_headers(client),
        )
        if not HTTP_OK_MIN <= response.status_code < HTTP_OK_MAX:
            detail = _safe_error_detail(response.text)
            suffix = f": {detail}" if detail else ""
            message = f"DeerFlow Gateway upload failed: {response.status_code}{suffix}"
            if response.status_code < httpx.codes.INTERNAL_SERVER_ERROR:
                raise ProtocolError(message)
            raise DeerFlowGatewayError(message)
        data = response.json()
        uploaded = _parse_upload_response(data, expected_count=len(files))
        if not uploaded:
            raise ProtocolError("DeerFlow Gateway accepted no attachments")
        return uploaded

    async def _ensure_thread_exists(self, client: httpx.AsyncClient) -> None:
        response = await client.post(
            self._url("/api/threads"),
            json={
                "thread_id": self._config.session,
                "metadata": {"source": "synadia-nats-channel"},
            },
            headers=self._request_headers(client),
        )
        if response.status_code == httpx.codes.CONFLICT:
            return
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


async def deerflow_gateway_runner(
    prompt: str,
    config: ChannelConfig,
    *,
    http_client: httpx.AsyncClient | None = None,
    attachments: list[Attachment] | None = None,
) -> AsyncIterator[str]:
    """Run one prompt through the configured DeerFlow Gateway."""
    client = DeerFlowGatewayClient(config, http_client=http_client)
    try:
        async for chunk in client.stream_prompt(prompt, attachments=attachments):
            yield chunk
    finally:
        await client.aclose()


def _attachment_files(attachments: list[Attachment]) -> list[tuple[str, tuple[str, bytes]]]:
    files: list[tuple[str, tuple[str, bytes]]] = []
    for attachment in attachments:
        try:
            content = attachment.to_bytes()
        except binascii.Error as exc:
            raise ProtocolError(
                f"invalid base64 content for attachment {attachment.filename!r}"
            ) from exc
        files.append(("files", (attachment.filename, content)))
    return files


def _parse_upload_response(
    data: Any, *, expected_count: int | None = None
) -> list[UploadedAttachment]:
    if not isinstance(data, dict):
        return []
    if data.get("success") is False:
        raise ProtocolError("DeerFlow Gateway rejected attachment upload")
    skipped_files = data.get("skipped_files")
    if isinstance(skipped_files, list) and skipped_files:
        raise ProtocolError("DeerFlow Gateway skipped one or more attachments")
    files = data.get("files")
    if not isinstance(files, list):
        return []
    uploaded: list[UploadedAttachment] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        filename = item.get("filename")
        virtual_path = item.get("virtual_path")
        if not isinstance(filename, str) or not isinstance(virtual_path, str):
            continue
        uploaded.append(
            UploadedAttachment(
                filename=filename,
                virtual_path=virtual_path,
                size=_parse_optional_int(item.get("size")),
                path=item.get("path") if isinstance(item.get("path"), str) else None,
                artifact_url=(
                    item.get("artifact_url") if isinstance(item.get("artifact_url"), str) else None
                ),
            )
        )
    if expected_count is not None and len(uploaded) != expected_count:
        raise ProtocolError("DeerFlow Gateway did not accept all attachments")
    return uploaded


def _parse_optional_int(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    return None


def _uploaded_attachment_metadata(attachment: UploadedAttachment) -> dict[str, Any]:
    data: dict[str, Any] = {
        "filename": attachment.filename,
        "path": attachment.virtual_path,
        "status": "uploaded",
    }
    if attachment.size is not None:
        data["size"] = attachment.size
    if attachment.artifact_url is not None:
        data["artifact_url"] = attachment.artifact_url
    return data


def _prompt_request_body(
    prompt: str,
    *,
    uploaded_attachments: list[UploadedAttachment] | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {
        "type": "human",
        "content": [{"type": "text", "text": prompt}],
    }
    if uploaded_attachments:
        message["additional_kwargs"] = {
            "files": [
                _uploaded_attachment_metadata(attachment) for attachment in uploaded_attachments
            ]
        }
    return {
        "assistant_id": "lead_agent",
        "input": {"messages": [message]},
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


MESSAGE_EVENTS = {"messages", "messages-tuple", "updates", "values"}
INTERNAL_KEYS = {
    "additional_kwargs",
    "artifact",
    "config",
    "kwargs",
    "lc_kwargs",
    "metadata",
    "response_metadata",
    "usage_metadata",
}
ASSISTANT_TYPES = {"ai", "assistant", "AIMessage", "AIMessageChunk"}
ASSISTANT_ROLES = {"assistant", "ai"}
MAX_TOOL_NAME_CHARS = 80
LANGGRAPH_TUPLE_ITEMS = 2
MAX_STATE_TRAVERSAL_DEPTH = 32


def _extract_events_from_sse_event(event: str, data: Any) -> list[DeerFlowEvent]:
    """Extract all user-visible semantic events from one DeerFlow SSE frame."""
    semantic_events: list[DeerFlowEvent] = []
    for message in _iter_message_payloads(event, data):
        clarification = _extract_clarification(message)
        if clarification:
            semantic_events.append(ClarificationEvent(prompt=clarification))
            continue
        status = _extract_tool_status(message)
        if status:
            semantic_events.append(ToolEvent(status=status))
            continue
        text = _extract_text(message)
        if text:
            semantic_events.append(TextEvent(text=text))
    return semantic_events


def _extract_clarification_from_sse_event(event: str, data: Any) -> str | None:
    """Extract DeerFlow ask_clarification tool text from SSE event data."""
    for message in _iter_message_payloads(event, data):
        clarification = _extract_clarification(message)
        if clarification:
            return clarification
    return None


def _extract_tool_status_from_sse_event(event: str, data: Any) -> str | None:
    """Extract meaningful DeerFlow tool activity without leaking metadata noise."""
    for message in _iter_message_payloads(event, data):
        status = _extract_tool_status(message)
        if status:
            return status
    return None


def _extract_text_from_sse_event(event: str, data: Any) -> str | None:
    """Extract assistant-visible text from LangGraph/DeerFlow SSE event data."""
    for message in _iter_message_payloads(event, data):
        text = _extract_text(message)
        if text:
            return text
    return None


def _walk_message_payloads(event: str, data: Any) -> list[Any]:
    if event not in MESSAGE_EVENTS:
        return []
    if event in {"messages", "messages-tuple"}:
        return list(_message_event_payloads(data))
    return list(_state_message_payloads(data))


def _iter_message_payloads(event: str, data: Any) -> list[Any]:
    return _walk_message_payloads(event, data)


def _message_event_payloads(data: Any) -> list[Any]:
    """Return only the message half of LangGraph `[message, metadata]` tuples."""
    if isinstance(data, list):
        if (
            len(data) == LANGGRAPH_TUPLE_ITEMS
            and isinstance(data[1], dict)
            and bool(_coerce_message_list(data[0]))
            and not _looks_like_message(data[1])
        ):
            return _coerce_message_list(data[0])
        return [item for item in data if _looks_like_message(item)]
    if _looks_like_message(data):
        return [data]
    if isinstance(data, dict):
        return _state_message_payloads(data)
    return []


def _state_message_payloads(value: Any, *, depth: int = 0) -> list[Any]:
    if depth > MAX_STATE_TRAVERSAL_DEPTH:
        return []

    messages: list[Any] = []
    if isinstance(value, dict):
        for key in ("messages", "message"):
            if key in value:
                messages.extend(_coerce_message_list(value[key]))
        for key, nested in value.items():
            if key in INTERNAL_KEYS or key in {"content", "text", "messages", "message"}:
                continue
            if isinstance(nested, dict | list):
                messages.extend(_state_message_payloads(nested, depth=depth + 1))
    elif isinstance(value, list):
        for item in value:
            if _looks_like_message(item):
                messages.append(item)
            elif isinstance(item, dict | list):
                messages.extend(_state_message_payloads(item, depth=depth + 1))
    return messages


def _coerce_message_list(value: Any) -> list[Any]:
    if _looks_like_message(value):
        return [value]
    if isinstance(value, list):
        return [item for item in value if _looks_like_message(item)]
    return []


def _looks_like_message(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    if value.get("name") == "ask_clarification":
        return True
    role = value.get("role")
    if isinstance(role, str) and role in ASSISTANT_ROLES | {"user", "human", "tool"}:
        return True
    message_type = value.get("type")
    if isinstance(message_type, str) and message_type in ASSISTANT_TYPES | {
        "human",
        "user",
        "tool",
    }:
        return True
    if "tool_calls" in value or "tool_call_chunks" in value or "tool_call_id" in value:
        return True
    return (
        isinstance(value.get("additional_kwargs"), dict)
        and "tool_calls" in value["additional_kwargs"]
    )


def _extract_tool_status(value: Any) -> str | None:  # noqa: PLR0911
    if not isinstance(value, dict):
        return None
    if value.get("name") == "ask_clarification":
        return None

    for tool_calls in (
        value.get("tool_calls"),
        value.get("tool_call_chunks"),
        _additional_tool_calls(value),
    ):
        status = _extract_tool_call_status(tool_calls)
        if status:
            return status

    name = value.get("name")
    message_type = value.get("type")
    if message_type == "tool":
        if isinstance(name, str) and name:
            return f"DeerFlow tool result: {_safe_tool_name(name)}"
        if isinstance(value.get("tool_call_id"), str):
            return "DeerFlow tool result"
    if isinstance(name, str) and name and str(value.get("id", "")).startswith("call_"):
        return f"DeerFlow tool call: {_safe_tool_name(name)}"
    return None


def _additional_tool_calls(value: dict[str, Any]) -> Any:
    additional_kwargs = value.get("additional_kwargs")
    if isinstance(additional_kwargs, dict):
        return additional_kwargs.get("tool_calls")
    return None


def _extract_tool_call_status(tool_calls: Any) -> str | None:
    if isinstance(tool_calls, dict):
        name = _tool_call_name(tool_calls)
        if name:
            return f"DeerFlow tool call: {_safe_tool_name(name)}"
    if isinstance(tool_calls, list):
        for item in tool_calls:
            status = _extract_tool_call_status(item)
            if status:
                return status
    return None


def _tool_call_name(tool_call: dict[str, Any]) -> str | None:
    name = tool_call.get("name")
    if isinstance(name, str) and name:
        return name
    function = tool_call.get("function")
    if isinstance(function, dict):
        function_name = function.get("name")
        if isinstance(function_name, str) and function_name:
            return function_name
    return None


def _safe_tool_name(name: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in {"_", "-", "."} else "_" for ch in name).strip("_")
    if not safe:
        return "unknown"
    if len(safe) > MAX_TOOL_NAME_CHARS:
        safe = safe[: MAX_TOOL_NAME_CHARS - 1] + "…"
    return safe


def _extract_clarification(value: Any) -> str | None:
    if not isinstance(value, dict) or value.get("name") != "ask_clarification":
        return None
    content = value.get("content")
    if isinstance(content, str) and content:
        return content
    return None


def _extract_text(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    if value.get("name") == "ask_clarification" or not _is_assistant_message(value):
        return None
    return _extract_text_content(value.get("content"))


def _extract_text_content(content: Any) -> str | None:
    if isinstance(content, str):
        return content or None
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") not in {None, "text"}:
                    continue
                text = item.get("text")
                if isinstance(text, str) and text:
                    parts.append(text)
            elif isinstance(item, str) and item:
                parts.append(item)
        if parts:
            return "".join(parts)
    return None


def _is_assistant_message(value: dict[str, Any]) -> bool:
    role = value.get("role")
    if isinstance(role, str):
        return role in ASSISTANT_ROLES

    message_type = value.get("type")
    if isinstance(message_type, str):
        return message_type in ASSISTANT_TYPES

    return False

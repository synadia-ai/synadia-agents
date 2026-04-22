"""Typed stream chunk messages per protocol §6.2 through §7.1.

Every non-terminating chunk is a JSON object ``{"type": "...", "data": ...}``
whose ``data`` shape depends on the discriminator (§6.2):

- ``response``: ``data`` is a string (bare-text shorthand, §6.3) OR an object
  with ``text`` + optional ``attachments``.
- ``status``:   ``data`` is a string status token (``"ack"``, ``"done"``, or
  any unknown value - unknown values MUST be silently ignored by callers per §6.4).
- ``query``:    ``data`` is an object with ``id``, ``reply_subject``,
  ``prompt``, and optional ``attachments`` (§7.1).

§6.2 forbids the plain-text shorthand on the response side — ``decode_chunk``
always JSON-parses and raises :class:`ProtocolError` for non-JSON. Unknown
top-level ``type`` values are silently dropped (§6.6) — the decoder returns
``None`` and ``Client._stream_prompt`` filters those out.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict

from .envelope import Attachment
from .errors import ProtocolError


class ResponseChunk(BaseModel):
    """Content chunk per §6.3."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    text: str
    attachments: list[Attachment] | None = None


class StatusChunk(BaseModel):
    """Lifecycle signal per §6.4. ``status`` is typically ``"ack"``; callers
    accept any string so future tokens flow through unchanged (§6.6)."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    status: str


class QueryChunk(BaseModel):
    """Agent-initiated mid-stream question per §7.1."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    id: str
    reply_subject: str
    prompt: str
    attachments: list[Attachment] | None = None


Chunk = ResponseChunk | StatusChunk | QueryChunk
"""One decoded chunk. Not a discriminated union on the wire - see :func:`decode_chunk`."""


def decode_chunk(payload: bytes) -> Chunk | None:
    """Decode a wire chunk per §6.2.

    Every non-terminating chunk MUST be a JSON object with a ``type``
    discriminator — §6.2 forbids plain-text shorthand on the response side.
    Returns ``None`` for unknown ``type`` values (§6.6: callers silently
    drop). Raises :class:`ProtocolError` for malformed JSON, a non-object
    body, a missing/non-string ``type``, or a *recognized* ``type`` with a
    malformed body (e.g. a ``response`` chunk missing ``text``).
    """
    try:
        obj = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"malformed chunk JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise ProtocolError("chunk body must be a JSON object")

    chunk_type = obj.get("type")
    data = obj.get("data")
    if not isinstance(chunk_type, str):
        raise ProtocolError("chunk missing string `type`")

    if chunk_type == "response":
        return _decode_response_data(data)
    if chunk_type == "status":
        if not isinstance(data, str):
            raise ProtocolError("`status` chunk `data` must be a string")
        return StatusChunk(status=data)
    if chunk_type == "query":
        return _decode_query_data(data)
    return None  # §6.6 — unknown type, silently drop


def _decode_response_data(data: Any) -> ResponseChunk:
    if isinstance(data, str):
        return ResponseChunk(text=data)
    if not isinstance(data, dict):
        raise ProtocolError("`response` chunk `data` must be a string or object")
    text = data.get("text")
    if not isinstance(text, str):
        raise ProtocolError("`response` chunk `data.text` must be a string")
    atts = _decode_attachments(data.get("attachments"), "response")
    return ResponseChunk(text=text, attachments=atts)


def _decode_query_data(data: Any) -> QueryChunk:
    if not isinstance(data, dict):
        raise ProtocolError("`query` chunk `data` must be an object")
    qid = data.get("id")
    reply_subject = data.get("reply_subject")
    prompt = data.get("prompt")
    if not isinstance(qid, str):
        raise ProtocolError("`query` chunk missing string `id`")
    if not isinstance(reply_subject, str):
        raise ProtocolError("`query` chunk missing string `reply_subject`")
    if not isinstance(prompt, str):
        raise ProtocolError("`query` chunk missing string `prompt`")
    atts = _decode_attachments(data.get("attachments"), "query")
    return QueryChunk(id=qid, reply_subject=reply_subject, prompt=prompt, attachments=atts)


def _decode_attachments(raw: Any, ctx: str) -> list[Attachment] | None:
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ProtocolError(f"`{ctx}` chunk `attachments` must be a list")
    out: list[Attachment] = []
    for idx, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ProtocolError(f"`{ctx}` chunk attachment #{idx} must be an object")
        out.append(Attachment(**item))
    return out


def encode_chunk(chunk: Chunk) -> bytes:
    """Serialize a typed chunk to wire bytes per §6.2."""
    if isinstance(chunk, ResponseChunk):
        data: Any
        if chunk.attachments:
            data = {
                "text": chunk.text,
                "attachments": [a.model_dump() for a in chunk.attachments],
            }
        else:
            data = chunk.text  # bare-string shorthand when no attachments
        return json.dumps({"type": "response", "data": data}).encode("utf-8")
    if isinstance(chunk, StatusChunk):
        return json.dumps({"type": "status", "data": chunk.status}).encode("utf-8")
    if isinstance(chunk, QueryChunk):
        query_data: dict[str, Any] = {
            "id": chunk.id,
            "reply_subject": chunk.reply_subject,
            "prompt": chunk.prompt,
        }
        if chunk.attachments:
            query_data["attachments"] = [a.model_dump() for a in chunk.attachments]
        return json.dumps({"type": "query", "data": query_data}).encode("utf-8")
    raise TypeError(f"unsupported chunk type: {type(chunk).__name__}")

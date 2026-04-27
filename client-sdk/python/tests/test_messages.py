"""Unit tests for the stream-chunk decoder (§6.2, §6.3, §6.4, §6.6, §7.1).

Pure tests — no NATS involvement — so they run alongside ``test_envelope.py``
without the integration fixtures.
"""

from __future__ import annotations

import json

import pytest

from synadia_ai.agents import QueryChunk, ResponseChunk, StatusChunk
from synadia_ai.agents.errors import ProtocolError
from synadia_ai.agents.messages import decode_chunk, encode_chunk


class TestResponseChunk:
    def test_decode_string_data(self) -> None:
        chunk = decode_chunk(b'{"type":"response","data":"hello"}')
        assert chunk == ResponseChunk(text="hello")

    def test_decode_object_data(self) -> None:
        chunk = decode_chunk(b'{"type":"response","data":{"text":"hi"}}')
        assert chunk == ResponseChunk(text="hi")

    def test_decode_object_with_attachments(self) -> None:
        chunk = decode_chunk(
            b'{"type":"response","data":{"text":"see",'
            b'"attachments":[{"filename":"a.pdf","content":"aGVsbG8="}]}}'
        )
        assert isinstance(chunk, ResponseChunk)
        assert chunk.text == "see"
        assert chunk.attachments is not None
        assert chunk.attachments[0].filename == "a.pdf"

    def test_object_missing_text_rejected(self) -> None:
        with pytest.raises(ProtocolError):
            decode_chunk(b'{"type":"response","data":{"attachments":[]}}')

    def test_encode_bare_string_when_no_attachments(self) -> None:
        """§6.3 bare-string shorthand: emit ``"data": "<text>"`` not ``{"text":...}``."""
        wire = encode_chunk(ResponseChunk(text="hi"))
        assert json.loads(wire) == {"type": "response", "data": "hi"}


class TestStatusChunk:
    def test_decode_ack(self) -> None:
        chunk = decode_chunk(b'{"type":"status","data":"ack"}')
        assert chunk == StatusChunk(status="ack")

    def test_unknown_status_tokens_pass_through(self) -> None:
        """§6.4 + §6.6: unknown status values MUST NOT be rejected."""
        chunk = decode_chunk(b'{"type":"status","data":"future-token"}')
        assert chunk == StatusChunk(status="future-token")

    def test_non_string_status_rejected(self) -> None:
        with pytest.raises(ProtocolError):
            decode_chunk(b'{"type":"status","data":42}')


class TestQueryChunk:
    def test_decode_happy(self) -> None:
        chunk = decode_chunk(
            b'{"type":"query","data":{"id":"q1","reply_subject":"_INBOX.X","prompt":"ok?"}}'
        )
        assert chunk == QueryChunk(id="q1", reply_subject="_INBOX.X", prompt="ok?")

    def test_missing_field_rejected(self) -> None:
        with pytest.raises(ProtocolError):
            decode_chunk(b'{"type":"query","data":{"id":"q1","prompt":"?"}}')


class TestForwardCompat:
    """§6.6: unknown chunk types MUST be silently ignored by callers."""

    def test_unknown_type_returns_none(self) -> None:
        assert decode_chunk(b'{"type":"future-chunk","data":{"whatever":1}}') is None

    def test_unknown_type_with_string_data_returns_none(self) -> None:
        assert decode_chunk(b'{"type":"heartbeat-snapshot","data":"opaque"}') is None

    def test_known_type_with_unknown_data_fields_tolerated(self) -> None:
        """§6.6: unknown fields inside a ``data`` object MUST be tolerated."""
        chunk = decode_chunk(b'{"type":"response","data":{"text":"hi","future_field":42}}')
        assert isinstance(chunk, ResponseChunk)
        assert chunk.text == "hi"


class TestMalformed:
    def test_malformed_json_raises(self) -> None:
        with pytest.raises(ProtocolError):
            decode_chunk(b'{"type":"response","data":')

    def test_non_object_body_raises(self) -> None:
        with pytest.raises(ProtocolError):
            decode_chunk(b"[1,2,3]")

    def test_missing_type_raises(self) -> None:
        with pytest.raises(ProtocolError):
            decode_chunk(b'{"data":"hi"}')


def test_plain_text_rejected_on_response_side() -> None:
    """§6.2: plain-text shorthand is ONLY valid for request envelopes (§5.3).
    Every non-terminating response-side chunk MUST be JSON with a ``type``."""
    with pytest.raises(ProtocolError):
        decode_chunk(b"hello world")

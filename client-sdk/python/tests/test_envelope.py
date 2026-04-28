"""Unit tests for envelope encoding/decoding per protocol §5.

Pure tests - no NATS involvement - so they run without the integration
fixtures. Wire-level evidence (agents receiving and emitting these
encodings live on the wire) lives in ``test_echo_e2e.py``.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from synadia_ai.agents import Attachment, Envelope, decode, encode
from synadia_ai.agents.envelope import looks_like_json
from synadia_ai.agents.errors import ProtocolError


class TestDiscrimination:
    """§5.3 - first non-whitespace byte ``{`` means JSON, else plain text."""

    def test_json_with_leading_brace(self) -> None:
        assert looks_like_json(b'{"prompt":"hi"}') is True

    def test_json_with_leading_whitespace(self) -> None:
        assert looks_like_json(b'   \n\t {"prompt":"hi"}') is True

    def test_plain_text(self) -> None:
        assert looks_like_json(b"hello world") is False

    def test_plain_text_starting_with_digit(self) -> None:
        # Answering a numbered menu with "5" is the canonical §7.2 reply.
        assert looks_like_json(b"5") is False

    def test_all_whitespace(self) -> None:
        assert looks_like_json(b"   \n  ") is False

    def test_empty(self) -> None:
        assert looks_like_json(b"") is False


class TestPlainTextShorthand:
    """§5.3 - a plain-text payload is promoted to ``{"prompt": <text>}``."""

    def test_simple_text(self) -> None:
        env = decode(b"hello world")
        assert env == Envelope(prompt="hello world")

    def test_unicode_text(self) -> None:
        env = decode(b"naive cafe")
        assert env == Envelope(prompt="naive cafe")

    def test_text_starting_with_digit_is_not_json(self) -> None:
        env = decode(b"5")
        assert env == Envelope(prompt="5")

    def test_invalid_utf8_raises(self) -> None:
        with pytest.raises(ProtocolError):
            decode(b"\xff\xfe not utf-8 and not json")

    def test_zero_byte_payload_rejected(self) -> None:
        # §5.3 - zero-byte payload is invalid.
        with pytest.raises(ProtocolError):
            decode(b"")


class TestJsonEnvelope:
    def test_prompt_only(self) -> None:
        env = decode(b'{"prompt":"hi"}')
        assert env == Envelope(prompt="hi")

    def test_attachment_decodes(self) -> None:
        env = decode(
            b'{"prompt":"summarize","attachments":[{"filename":"doc.pdf","content":"aGVsbG8="}]}'
        )
        assert env.prompt == "summarize"
        assert env.attachments is not None
        assert len(env.attachments) == 1
        att = env.attachments[0]
        assert att.filename == "doc.pdf"
        assert att.to_bytes() == b"hello"

    def test_multiple_attachments(self) -> None:
        env = decode(
            b'{"prompt":"see attached",'
            b'"attachments":['
            b'{"filename":"a.pdf","content":"aGk="},'
            b'{"filename":"b.png","content":"YWJj"}'
            b"]}"
        )
        assert env.attachments is not None
        assert len(env.attachments) == 2

    def test_unknown_fields_tolerated(self) -> None:
        """§5.6 - envelope decoders MUST tolerate unknown top-level fields."""
        env = decode(b'{"prompt":"hi","future_field":42,"another":"ok"}')
        assert env.prompt == "hi"
        assert env.attachments is None

    def test_inbound_session_field_rides_unknown_field_bag(self) -> None:
        """A stray ``session`` from a non-compliant peer decodes as a
        normal envelope: under v0.3 the subject IS the session, so
        ``Envelope.session`` is no longer a first-class field — the key
        rides §5.6's ``extra="allow"`` bag instead.
        """
        env = decode(b'{"prompt":"hi","session":"foo"}')
        assert env.prompt == "hi"
        # Not a declared field on the model.
        assert "session" not in Envelope.model_fields
        # Did land in the extras bag.
        assert env.model_extra == {"session": "foo"}
        # decode → encode round-trips the stray field via §5.6.
        parsed = json.loads(encode(env))
        assert parsed["session"] == "foo"

    def test_empty_prompt_allowed_at_decode(self) -> None:
        """An empty string for ``prompt`` is decodable - client-side validation
        (§5.4) is the layer that rejects it before publish."""
        env = decode(b'{"prompt":""}')
        assert env.prompt == ""

    def test_missing_prompt_rejected(self) -> None:
        with pytest.raises(ProtocolError):
            decode(b'{"attachments":[]}')


class TestRoundTrip:
    def test_prompt_only_roundtrip(self) -> None:
        original = Envelope(prompt="hello")
        round_tripped = decode(encode(original))
        assert round_tripped == original

    def test_attachment_roundtrip(self) -> None:
        original = Envelope(
            prompt="describe",
            attachments=[Attachment.from_bytes("payload.bin", b"\x00\x01\x02\x03")],
        )
        round_tripped = decode(encode(original))
        assert round_tripped == original
        assert round_tripped.attachments is not None
        assert round_tripped.attachments[0].to_bytes() == b"\x00\x01\x02\x03"

    def test_encoded_wire_is_valid_json(self) -> None:
        env = Envelope(prompt="x")
        parsed = json.loads(encode(env))
        assert parsed == {"prompt": "x"}

    def test_encoded_attachments_form(self) -> None:
        """Verify the exact wire shape per §5.1 + §5.2."""
        env = Envelope(prompt="x", attachments=[Attachment.from_bytes("f.bin", b"ab")])
        parsed = json.loads(encode(env))
        assert parsed == {
            "prompt": "x",
            "attachments": [
                {"filename": "f.bin", "content": base64.b64encode(b"ab").decode("ascii")}
            ],
        }

    def test_no_attachments_field_omitted_on_wire(self) -> None:
        """When ``attachments`` is None, the field must be absent from the wire."""
        env = Envelope(prompt="x")
        parsed = json.loads(encode(env))
        assert "attachments" not in parsed


class TestUnknownFieldPreservation:
    """§5.6 - unknown top-level fields MUST be preserved on decode → encode.

    Without this, a relay that re-serializes an envelope would silently drop
    forward-compat extensions (future routing headers, trace ids, ...).
    """

    def test_unknown_field_roundtrips(self) -> None:
        env = decode(b'{"prompt":"hi","x-trace-id":"abc123"}')
        parsed = json.loads(encode(env))
        assert parsed["prompt"] == "hi"
        assert parsed["x-trace-id"] == "abc123"

    def test_multiple_unknown_fields_preserved(self) -> None:
        env = decode(b'{"prompt":"hi","x-trace-id":"abc","x-tenant":"acme"}')
        parsed = json.loads(encode(env))
        assert parsed["x-trace-id"] == "abc"
        assert parsed["x-tenant"] == "acme"

    def test_unknown_field_alongside_stray_session(self) -> None:
        # An inbound stray `session` rides the §5.6 unknown-field bag —
        # round-trips losslessly without surfacing as a first-class field.
        env = decode(b'{"prompt":"hi","session":"s","x-trace-id":"t"}')
        parsed = json.loads(encode(env))
        assert parsed["session"] == "s"
        assert parsed["x-trace-id"] == "t"


class TestAttachment:
    def test_from_bytes(self) -> None:
        att = Attachment.from_bytes("doc.pdf", b"PDF-content")
        assert att.filename == "doc.pdf"
        assert att.to_bytes() == b"PDF-content"
        # Wire content is standard-alphabet base64, padded.
        assert att.content == base64.b64encode(b"PDF-content").decode("ascii")

    def test_from_path_uses_basename(self, tmp_path: Path) -> None:
        p = tmp_path / "sub" / "nested.txt"
        p.parent.mkdir(parents=True)
        p.write_bytes(b"contents")
        att = Attachment.from_path(p)
        assert att.filename == "nested.txt"
        assert att.to_bytes() == b"contents"

    def test_base64_is_standard_alphabet(self) -> None:
        """Standard (not URL-safe) alphabet - spec §5.2 is explicit."""
        att = Attachment.from_bytes("x.bin", b"\xff\xfe\xfd")
        # 0xff 0xfe 0xfd -> "//79" in standard alphabet, "__79" in URL-safe.
        assert att.content == "//79"

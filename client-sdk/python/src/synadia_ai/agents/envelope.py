"""Wire envelope per protocol §5.

The request envelope is a JSON object carrying at minimum a non-empty
`prompt` string and an optional `attachments` list. Plain UTF-8 text is
accepted as shorthand for `{"prompt": <text>}` (§5.3). Reply payloads for
mid-stream queries reuse the same shape (§7.2).

Attachments carry bytes as RFC 4648 §4 base64 (standard alphabet, padded;
no URL-safe, no whitespace). Callers use `Attachment.from_bytes` /
`Attachment.from_path` / `.to_bytes()` — the base64 boundary is at the
constructor, not the wire.

Unknown top-level fields are tolerated (§5.6): `extra="allow"` preserves
them on the parsed envelope and re-emits them on `encode()`, so a decode →
encode round-trip is lossless for future extension fields. Production
agents that forward raw bytes rather than re-serializing remain correct
either way.
"""

from __future__ import annotations

import base64
from pathlib import Path

from pydantic import BaseModel, ConfigDict, ValidationError

from .errors import ProtocolError


class Attachment(BaseModel):
    """One attachment per spec §5.2.

    Wire shape:
        {"filename": "<name>", "content": "<standard-alphabet base64>"}
    """

    model_config = ConfigDict(extra="ignore", frozen=True)

    filename: str
    content: str  # RFC 4648 §4 base64, padded, no URL-safe alphabet, no whitespace

    @classmethod
    def from_bytes(cls, filename: str, data: bytes) -> Attachment:
        """Build an Attachment from raw bytes (base64-encodes `data`)."""
        return cls(filename=filename, content=base64.b64encode(data).decode("ascii"))

    @classmethod
    def from_path(cls, path: str | Path) -> Attachment:
        """Read the file at `path`; keep only the basename as `filename` (no directory leakage)."""
        p = Path(path)
        return cls.from_bytes(p.name, p.read_bytes())

    def to_bytes(self) -> bytes:
        """Decode the base64 content back to raw bytes.

        ``validate=True`` rejects non-RFC-4648 §4 input (URL-safe ``-``/``_``,
        embedded whitespace, other non-alphabet bytes) instead of silently
        discarding them — a non-compliant peer that sends URL-safe base64
        surfaces as :class:`binascii.Error` rather than corrupted bytes.
        """
        return base64.b64decode(self.content, validate=True)


class Envelope(BaseModel):
    """Request / query-reply envelope per spec §5.1.

    `session` is an SDK convention tolerated on the wire per §5.6 —
    v0.2's §5.1 no longer defines `session` as a first-class envelope
    field, but the same extension-field preservation rules that apply to
    any unknown top-level key keep it round-trippable. Session-aware
    harnesses (Hermes, pi, ...) thread it through their own storage.

    `extra="allow"` preserves any other top-level field a future revision
    or peer SDK adds, so decode → encode is lossless (§5.6).
    """

    model_config = ConfigDict(extra="allow", frozen=True)

    prompt: str
    attachments: list[Attachment] | None = None
    session: str | None = None


def encode(envelope: Envelope) -> bytes:
    """Serialize an envelope to its JSON wire form (UTF-8 bytes).

    `attachments` is omitted from the wire when it is `None` so callers
    without attachments produce the compact form `{"prompt": "..."}`.
    """
    return envelope.model_dump_json(exclude_none=True).encode("utf-8")


def decode(payload: bytes) -> Envelope:
    """Decode an inbound wire payload per §5.3.

    Discrimination rule: if the first non-whitespace byte is `{`, parse as
    JSON; otherwise promote UTF-8 text to `{"prompt": <text>}`. Zero-byte
    payloads are rejected per §5.3 (status 400 territory on the server side).
    """
    if len(payload) == 0:
        raise ProtocolError("zero-byte payload (§5.3)")
    if looks_like_json(payload):
        try:
            return Envelope.model_validate_json(payload)
        except ValidationError as exc:
            raise ProtocolError(f"malformed envelope: {exc}") from exc

    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ProtocolError(
            "payload is not JSON (no leading '{') and not valid UTF-8 text"
        ) from exc
    return Envelope(prompt=text)


_JSON_OPEN_BRACE = ord("{")
_ASCII_WHITESPACE = frozenset({ord(" "), ord("\t"), ord("\n"), ord("\r")})


def looks_like_json(payload: bytes) -> bool:
    """Per §5.3: first non-whitespace byte `{` ⇒ interpret as JSON.

    Exposed (not private) because :mod:`messages` shares the same
    discrimination rule between request envelopes and stream chunks.
    """
    for byte in payload:
        if byte in _ASCII_WHITESPACE:
            continue
        return byte == _JSON_OPEN_BRACE
    return False

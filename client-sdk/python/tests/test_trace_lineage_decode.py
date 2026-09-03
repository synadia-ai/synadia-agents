"""Lineage on the wire is untrusted, bounded input.

``thread_id`` and ``root_id`` are the tracing extension's only additions to
the envelope. A receiver adopts them verbatim and stamps them on the
model requests it issues, as header values. So a value that is not shaped
exactly like what the SDKs mint — 32 lowercase hex characters — is a
malformed envelope (400), never something to adopt: a CRLF would reach a
third party's HTTP stack, a megabyte of garbage would ride every
completion request. The TypeScript SDK reads the wire the same way.
"""

from __future__ import annotations

import json

import pytest

from synadia_ai.agents import (
    THREAD_ID_HEX_LEN,
    Envelope,
    ProtocolError,
    decode,
    is_thread_id,
    random_thread_id,
)

THREAD = "a" * 32
ROOT = "b" * 32


def _wire(**fields: object) -> bytes:
    return json.dumps({"prompt": "x", **fields}).encode()


def test_reads_both_fields() -> None:
    env = decode(_wire(thread_id=THREAD, root_id=ROOT))
    assert env.thread_id == THREAD
    assert env.root_id == ROOT


@pytest.mark.parametrize(
    "body",
    [
        _wire(),
        _wire(thread_id=None),
        _wire(thread_id=""),
    ],
    ids=["absent", "null", "empty"],
)
def test_treats_absent_null_and_empty_as_no_lineage(body: bytes) -> None:
    assert decode(body).thread_id is None


@pytest.mark.parametrize(
    "value",
    [123, {}, [], True],
    ids=["number", "object", "array", "boolean"],
)
def test_rejects_a_wrongly_typed_id(value: object) -> None:
    with pytest.raises(ProtocolError):
        decode(_wire(thread_id=value))
    with pytest.raises(ProtocolError):
        decode(_wire(root_id=value))


@pytest.mark.parametrize(
    "value",
    [
        "A" * 32,
        "a" * 31,
        "a" * 33,
        "g" * 32,
        "a" * 30 + "\r\nX-Injected: yes",
        " " + "a" * 30 + " ",
        "a" * (1 << 20),
    ],
    ids=[
        "uppercase-hex",
        "one-short",
        "one-long",
        "non-hex",
        "header-injection",
        "whitespace",
        "megabyte",
    ],
)
def test_rejects_a_malformed_id(value: str) -> None:
    with pytest.raises(ProtocolError):
        decode(_wire(thread_id=value))
    with pytest.raises(ProtocolError):
        decode(_wire(root_id=value))


def test_an_explicit_envelope_is_held_to_the_same_shape() -> None:
    """A caller overriding lineage gets the error at construction, not on
    the wire — the receiver would refuse it anyway."""
    with pytest.raises(ValueError):
        Envelope(prompt="x", thread_id="not-a-thread-id")


def test_is_thread_id_matches_what_the_sdk_mints() -> None:
    minted = random_thread_id()
    assert len(minted) == THREAD_ID_HEX_LEN
    assert is_thread_id(minted)
    assert is_thread_id(THREAD)
    assert not is_thread_id(THREAD.upper())
    assert not is_thread_id("")

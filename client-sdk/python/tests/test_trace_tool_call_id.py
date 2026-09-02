"""Both SDKs bound the tool call id the same way.

The id a caller passes labels the edge record. The bound is in Unicode
code points — what ``len()`` counts, and what the TypeScript SDK now
counts too instead of UTF-16 units — so a mixed-language fleet accepts
exactly the same ids. A lone surrogate has no UTF-8 form and is rejected
on both sides. The record itself writes non-ASCII text raw, as
``JSON.stringify`` does, so the two SDKs stay byte-identical.
"""

from __future__ import annotations

import json

from synadia_ai.agents import TOOL_CALL_ID_MAX, build_edge_record, valid_tool_call_id

THREAD = "a" * 32


def test_accepts_an_ordinary_id() -> None:
    assert valid_tool_call_id("call_1")
    assert valid_tool_call_id("toolu_01A09q90qw90lq917835lq9")


def test_rejects_an_empty_id() -> None:
    assert not valid_tool_call_id("")


def test_bounds_the_length_in_code_points() -> None:
    assert valid_tool_call_id("a" * TOOL_CALL_ID_MAX)
    assert not valid_tool_call_id("a" * (TOOL_CALL_ID_MAX + 1))
    assert valid_tool_call_id("🙂" * TOOL_CALL_ID_MAX)
    assert not valid_tool_call_id("🙂" * (TOOL_CALL_ID_MAX + 1))


def test_rejects_a_lone_surrogate_half() -> None:
    assert not valid_tool_call_id("\ud83d")
    assert not valid_tool_call_id("call_\ude42")
    assert not valid_tool_call_id("a\ud83db")


def test_the_record_writes_a_non_ascii_id_raw() -> None:
    _, payload = build_edge_record(THREAD, None, THREAD, "call_é🙂", 0)
    assert b'"tool_call_id":"call_\xc3\xa9\xf0\x9f\x99\x82"' in payload
    assert b"\\u" not in payload
    assert json.loads(payload)["tool_call_id"] == "call_é🙂"

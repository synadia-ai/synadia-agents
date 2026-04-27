"""Unit tests for :mod:`synadia_ai.agents._bytes` (size parsing + UTF-8 length).

Spec §2.1 fixes the `max_payload` grammar but leaves base (1000 vs 1024)
and case sensitivity unspecified. We pin the interpretation here so the
choice is explicit and easily revisited if the spec tightens.
"""

from __future__ import annotations

import pytest

from synadia_ai.agents._bytes import InvalidSizeError, parse_human_bytes, utf8_byte_length


class TestParseHumanBytes:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("0B", 0),
            ("1B", 1),
            ("512KB", 512 * 1024),
            ("1MB", 1024 * 1024),
            ("4GB", 4 * 1024 * 1024 * 1024),
        ],
    )
    def test_happy_path(self, value: str, expected: int) -> None:
        assert parse_human_bytes(value) == expected

    def test_case_insensitive(self) -> None:
        assert parse_human_bytes("1mb") == 1024 * 1024
        assert parse_human_bytes("4gB") == 4 * 1024 * 1024 * 1024

    def test_whitespace_tolerated(self) -> None:
        assert parse_human_bytes("  1 MB  ") == 1024 * 1024

    @pytest.mark.parametrize("value", ["", "abc", "1", "1TB", "-1MB", "1.5MB", "MB"])
    def test_rejects_malformed(self, value: str) -> None:
        with pytest.raises(InvalidSizeError):
            parse_human_bytes(value)


class TestUtf8ByteLength:
    def test_ascii(self) -> None:
        assert utf8_byte_length("hello") == 5

    def test_multibyte_is_counted_in_bytes_not_chars(self) -> None:
        # Euro sign is 3 bytes in UTF-8; "e" is 1.
        assert utf8_byte_length("e€") == 1 + 3

    def test_empty(self) -> None:
        assert utf8_byte_length("") == 0

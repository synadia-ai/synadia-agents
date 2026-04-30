"""Unit tests for :mod:`synadia_ai.agents._bytes` (size parsing + UTF-8 length).

Spec §2.1 fixes the `max_payload` grammar but leaves base (1000 vs 1024)
and case sensitivity unspecified. We pin the interpretation here so the
choice is explicit and easily revisited if the spec tightens.
"""

from __future__ import annotations

import pytest

from synadia_ai.agents._bytes import (
    InvalidSizeError,
    format_human_bytes,
    parse_human_bytes,
    utf8_byte_length,
)


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


class TestFormatHumanBytes:
    @pytest.mark.parametrize(
        ("byte_count", "expected"),
        [
            (0, "0B"),
            (1, "1B"),
            (512 * 1024, "512KB"),
            (1024 * 1024, "1MB"),
            (8 * 1024 * 1024, "8MB"),
            (4 * 1024 * 1024 * 1024, "4GB"),
        ],
    )
    def test_happy_path(self, byte_count: int, expected: str) -> None:
        assert format_human_bytes(byte_count) == expected

    def test_picks_largest_clean_unit(self) -> None:
        # 8MB-worth of bytes round-trips to "8MB", not "8192KB".
        assert format_human_bytes(8 * 1024 * 1024) == "8MB"

    def test_falls_back_to_bytes_when_no_clean_unit(self) -> None:
        # 1500 bytes isn't a whole number of KB/MB/GB.
        assert format_human_bytes(1500) == "1500B"

    @pytest.mark.parametrize("byte_count", [0, 1, 512, 1024, 1024 * 1024, 8 * 1024 * 1024])
    def test_round_trip_with_parse(self, byte_count: int) -> None:
        assert parse_human_bytes(format_human_bytes(byte_count)) == byte_count

    def test_rejects_negative(self) -> None:
        with pytest.raises(InvalidSizeError):
            format_human_bytes(-1)


class TestUtf8ByteLength:
    def test_ascii(self) -> None:
        assert utf8_byte_length("hello") == 5

    def test_multibyte_is_counted_in_bytes_not_chars(self) -> None:
        # Euro sign is 3 bytes in UTF-8; "e" is 1.
        assert utf8_byte_length("e€") == 1 + 3

    def test_empty(self) -> None:
        assert utf8_byte_length("") == 0

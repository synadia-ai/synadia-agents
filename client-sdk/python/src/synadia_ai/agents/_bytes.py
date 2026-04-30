"""Size-unit parsing + UTF-8 byte-length measurement (internal).

Spec §2.1 defines ``max_payload`` as "a positive integer followed by ``B``,
``KB``, ``MB``, or ``GB``" but is silent on base (1000 vs 1024) and on case
sensitivity. We use base-1024 (matching ``nats-server`` config conventions)
and parse units case-insensitively. Both choices mirror the TS SDK; both are
flagged for upstream clarification.
"""

from __future__ import annotations

import re

_SIZE_PATTERN = re.compile(r"^\s*(\d+)\s*(B|KB|MB|GB)\s*$", re.IGNORECASE)

_MULTIPLIERS: dict[str, int] = {
    "B": 1,
    "KB": 1024,
    "MB": 1024 * 1024,
    "GB": 1024 * 1024 * 1024,
}


class InvalidSizeError(ValueError):
    """Raised when a human-readable size string can't be parsed per §2.1."""

    def __init__(self, value: str, reason: str) -> None:
        super().__init__(f"invalid size {value!r}: {reason}")
        self.value = value


def parse_human_bytes(value: str) -> int:
    """Parse a size string like ``"1MB"`` / ``"512KB"`` / ``"4gb"`` to bytes."""
    match = _SIZE_PATTERN.match(value)
    if match is None:
        raise InvalidSizeError(value, "expected e.g. '1MB', '512KB', '4GB'")
    number, unit = match.group(1), match.group(2).upper()
    multiplier = _MULTIPLIERS[unit]  # regex guarantees a known unit
    return int(number) * multiplier


# Largest unit first so a server-reported ``8388608`` formats back to ``"8MB"``,
# not ``"8192KB"``.
_FORMAT_UNITS: tuple[tuple[str, int], ...] = (
    ("GB", 1024**3),
    ("MB", 1024**2),
    ("KB", 1024),
)


def format_human_bytes(byte_count: int) -> str:
    """Format an integer byte count back into the §2.1 ``\\d+(B|KB|MB|GB)`` grammar.

    Picks the largest unit that divides ``byte_count`` evenly so a
    server-reported ``8 * 1024 * 1024`` round-trips cleanly to ``"8MB"``,
    not ``"8192KB"``. Used by :class:`AgentService` to format a clamped
    server-derived limit back into the spec's metadata grammar.
    """
    if byte_count < 0:
        raise InvalidSizeError(str(byte_count), "byte count must be non-negative")
    for unit, multiplier in _FORMAT_UNITS:
        if byte_count >= multiplier and byte_count % multiplier == 0:
            return f"{byte_count // multiplier}{unit}"
    return f"{byte_count}B"


def utf8_byte_length(text: str) -> int:
    """UTF-8 byte length of a Python string — pre-publish size check helper."""
    return len(text.encode("utf-8"))

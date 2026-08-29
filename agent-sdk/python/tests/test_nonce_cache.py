"""Nonce set semantics (plan §2.5), mirrored from the TS host's ``nonce-cache.test.ts``.

Keyed ``(user, nonce)``, expiry anchored on the header ``ts`` (not on
arrival), check-and-set, bounded by a cap with oldest-first eviction
logged once per overload (re-armed once normal expiry has drained the
set to half the cap), and second-bucketed sweeps.
"""

from __future__ import annotations

import logging

import pytest

from synadia_ai.agent_service import NonceCache

U1 = "UAAA"
U2 = "UBBB"
LOGGER = "synadia_ai.agent_service.identity"


def test_records_once_per_user_nonce_and_users_are_distinct() -> None:
    c = NonceCache(replay_window_s=30.0)
    now = 1_000_000.0
    assert c.record(U1, "n1", now, now) is True
    assert c.record(U1, "n1", now, now) is False
    assert c.has(U1, "n1", now) is True
    assert c.record(U2, "n1", now, now) is True
    assert c.size == 2


def test_expires_at_ts_plus_window_not_arrival_plus_window() -> None:
    c = NonceCache(replay_window_s=30.0)
    arrival = 1_000_000.0
    ts = arrival + 29.0  # legal: 29 s in the future
    assert c.record(U1, "future", ts, arrival) is True
    # arrival + 31 s: an arrival-anchored cache would have evicted it.
    assert c.has(U1, "future", arrival + 31.0) is True
    assert c.record(U1, "future", ts, arrival + 31.0) is False
    # ts + window + 1 s: gone.
    assert c.has(U1, "future", ts + 30.0 + 1.0) is False


def test_has_compares_the_stored_expiry_exactly() -> None:
    # The second-granular buckets only bound memory: an entry sitting in the
    # map past its expiry (bucket not yet swept) is never reported present.
    c = NonceCache(replay_window_s=1.0)
    c.record(U1, "n", 5_000_000.2, 5_000_000.2)  # expires at 5_000_001.2
    assert c.has(U1, "n", 5_000_001.1) is True
    assert c.has(U1, "n", 5_000_001.3) is False  # same bucket, past expiry
    assert c.size == 1  # still in the map until the bucket passes
    assert c.record(U1, "n", 5_000_001.3, 5_000_001.3) is True  # re-record after expiry


def test_re_recording_an_expired_key_survives_the_old_buckets_sweep() -> None:
    # The old (expired, unswept) bucket must not remove the fresh entry
    # recorded under the same key — otherwise the nonce would be replayable.
    c = NonceCache(replay_window_s=1.0)
    c.record(U1, "n", 5_000_000.0, 5_000_000.0)  # expires 5_000_001.0, bucket 5_000_001
    assert c.record(U1, "n", 5_000_001.5, 5_000_001.5) is True  # expires 5_000_002.5
    c.sweep(5_000_002.0)  # drops bucket 5_000_001
    assert c.has(U1, "n", 5_000_002.0) is True
    assert c.record(U1, "n", 5_000_001.5, 5_000_002.0) is False


def test_already_expired_header_is_not_stored() -> None:
    c = NonceCache(replay_window_s=30.0)
    now = 1_000_000.0
    assert c.record(U1, "stale", now - 60.0, now) is True
    assert c.size == 0


def test_sweeps_whole_second_buckets() -> None:
    c = NonceCache(replay_window_s=1.0)
    t0 = 5_000_000.0
    for i in range(10):
        c.record(U1, f"n{i}", t0 + i * 0.1, t0)
    assert c.size == 10
    c.sweep(t0 + 1.0)  # expiries land in [t0+1.0, t0+1.9] → bucket not yet passed
    assert c.size == 10
    c.sweep(t0 + 3.0)
    assert c.size == 0


def test_enforces_the_cap_by_evicting_the_oldest_buckets_and_logs_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    c = NonceCache(replay_window_s=30.0, max_entries=5)
    t0 = 9_000_000.0
    with caplog.at_level(logging.WARNING, logger=LOGGER):
        for i in range(8):
            c.record(U1, f"n{i}", t0 + i * 1.0, t0)
    assert c.size <= 5
    assert c.has(U1, "n0", t0) is False  # oldest evicted
    assert c.has(U1, "n7", t0) is True  # newest kept
    warnings = [r for r in caplog.records if "reached its cap" in r.getMessage()]
    assert len(warnings) == 1
    assert "may be replayed within the ts window" in warnings[0].getMessage()


def test_cap_warning_is_re_armed_once_expiry_drains_the_set_to_half_the_cap(
    caplog: pytest.LogCaptureFixture,
) -> None:
    c = NonceCache(replay_window_s=1.0, max_entries=4)
    t0 = 5_000_000.0
    with caplog.at_level(logging.WARNING, logger=LOGGER):
        # Sustained overload: every record past the cap evicts a bucket and
        # leaves the set at the cap — one warning for the whole episode.
        for i in range(12):
            c.record(U1, f"a{i}", t0 + i * 1.0, t0)
        assert c.size == 4
        assert sum("reached its cap" in r.getMessage() for r in caplog.records) == 1
        # Everything expires; the sweep re-arms the warning.
        c.sweep(t0 + 20.0)
        assert c.size == 0
        # A second overload is reported again.
        t1 = t0 + 20.0
        for i in range(6):
            c.record(U2, f"b{i}", t1 + i * 1.0, t1)
        assert sum("reached its cap" in r.getMessage() for r in caplog.records) == 2

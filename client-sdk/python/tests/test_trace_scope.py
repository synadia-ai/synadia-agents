"""``TraceScope`` is a value naming one execution.

It is frozen, so Python advertises it as hashable — which it must
actually be. The turn counter is a mutable cell carried inside it, so it
has to stay out of both equality and hashing: two scopes naming the same
execution are the same scope whatever their counters read, and a scope
must be usable as a dict key or set member.
"""

from __future__ import annotations

from synadia_ai.agents import TraceScope

THREAD = "a" * 32
ROOT = "b" * 32


def test_a_scope_is_hashable() -> None:
    assert hash(TraceScope(THREAD, ROOT)) == hash(TraceScope(THREAD, ROOT))
    assert len({TraceScope(THREAD, ROOT), TraceScope(THREAD, ROOT)}) == 1


def test_the_turn_counter_is_not_part_of_identity() -> None:
    counted = TraceScope(THREAD, ROOT)
    counted.turn_count_hint[0] += 3
    assert counted == TraceScope(THREAD, ROOT)
    assert hash(counted) == hash(TraceScope(THREAD, ROOT))


def test_lineage_is_part_of_identity() -> None:
    assert TraceScope(THREAD, ROOT) != TraceScope(ROOT, ROOT)
    assert TraceScope(THREAD, ROOT) != TraceScope(THREAD, THREAD)


def test_the_counter_starts_at_zero_and_is_not_shared() -> None:
    a, b = TraceScope(THREAD, ROOT), TraceScope(THREAD, ROOT)
    assert a.turn_count_hint == [0]
    a.turn_count_hint[0] += 1
    assert b.turn_count_hint == [0], "scopes shared one counter cell"

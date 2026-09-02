from __future__ import annotations

import json
import secrets
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

# Bump every time you change the trace record schema
# (be sure the TypeScript SDK is updated in lockstep)
EDGE_RECORD_VERSION = 2

# Default subject edge records are published to — the tenant-side short
# form; the account's import qualifies it.
DEFAULT_EDGE_SUBJECT = "TRACE.edges"


@dataclass(frozen=True, slots=True)
class TraceOptions:
    """Opt-in tracing configuration; passing an instance enables tracing.

    ``edge_subject`` is where edge records are published; ``None`` selects
    propagate-only mode — mint IDs and forward lineage, but publish no
    edge records.
    """

    edge_subject: str | None = DEFAULT_EDGE_SUBJECT


THREAD_ID_HEX_LEN = 32
TOOL_CALL_ID_MAX = 256


@dataclass(frozen=True, slots=True)
class TraceScope:
    thread_id: str
    root_id: str
    # How many times this execution has stamped trace headers on a model
    # request. Deliberately a mutable cell inside a frozen scope: a task
    # spawned inside the handler gets a copy of the context but shares
    # this object, so its model calls count against the same execution.
    model_calls: list[int] = field(default_factory=lambda: [0])


# The binding carries the service's tracing configuration alongside the
# ids, so an agent configured once passes tracing down to every client it
# uses inside the handler.
@dataclass(frozen=True, slots=True)
class _TraceBinding:
    scope: TraceScope
    options: TraceOptions | None


_active_binding: ContextVar[_TraceBinding | None] = ContextVar("synadia_active_trace", default=None)


@contextmanager
def bind_active_trace(
    trace_scope: TraceScope, options: TraceOptions | None = None
) -> Iterator[None]:
    token = _active_binding.set(_TraceBinding(trace_scope, options))
    try:
        yield
    finally:
        _active_binding.reset(token)


def active_trace() -> TraceScope | None:
    binding = _active_binding.get()
    return binding.scope if binding is not None else None


def inherited_trace_options() -> TraceOptions | None:
    # Tracing configuration handed down by the enclosing AgentService.
    # None when the service has none, or outside a handler.
    binding = _active_binding.get()
    return binding.options if binding is not None else None


def random_thread_id() -> str:
    # Thread IDs don't need to be secure and any random generator will suffice.
    # Still, using secrets.token_hex() doesn't cost us much.
    return secrets.token_hex(THREAD_ID_HEX_LEN // 2)


def valid_tool_call_id(tool_call_id: str) -> bool:
    # This isn't intended as strict validation. It's just a basic
    # pass to avoid obvious garbage gets into the tracing system.
    return 0 < len(tool_call_id) <= TOOL_CALL_ID_MAX


def build_edge_record(
    thread_id: str,
    parent_id: str | None,
    root_id: str,
    tool_call_id: str | None,
    turn_count_hint: int,
) -> tuple[str, bytes]:
    # Returns the record id alongside the payload: the publisher stamps it
    # as Nats-Msg-Id so a stream de-duplicates a record it already stored.
    #
    # `turn_count_hint` says where in the spawning thread this subprompt
    # went out: turns completed when it was spawned, 0 on a root (nothing
    # spawned it). A position marker, not a total — turns the parent takes
    # after its last spawn are recorded nowhere.
    record_id = random_thread_id()
    record = {
        "version": EDGE_RECORD_VERSION,
        "record_id": record_id,
        "ts": int(time.time()),
        "thread_id": thread_id,
        "parent_id": parent_id,
        "root_id": root_id,
        "tool_call_id": tool_call_id,
        "turn_count_hint": turn_count_hint,
    }
    return record_id, json.dumps(record, separators=(",", ":")).encode("utf-8")

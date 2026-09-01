from __future__ import annotations

import json
import secrets
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

# Bump every time you change the trace record schema
# (be sure the TypeScript SDK is updated in lockstep)
EDGE_RECORD_VERSION = 1

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


_active_trace: ContextVar[TraceScope | None] = ContextVar("synadia_active_trace", default=None)


@contextmanager
def bind_active_trace(trace_scope: TraceScope) -> Iterator[None]:
    token = _active_trace.set(trace_scope)
    try:
        yield
    finally:
        _active_trace.reset(token)


def active_trace() -> TraceScope | None:
    return _active_trace.get()


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
) -> bytes:
    record = {
        "version": EDGE_RECORD_VERSION,
        "record_id": random_thread_id(),
        "ts": int(time.time()),
        "thread_id": thread_id,
        "parent_id": parent_id,
        "root_id": root_id,
        "tool_call_id": tool_call_id,
    }
    return json.dumps(record, separators=(",", ":")).encode("utf-8")

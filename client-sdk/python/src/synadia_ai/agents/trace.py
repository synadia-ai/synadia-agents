import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

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


def active_trace() -> ContextVar[TraceScope | None]:
    return _active_trace


def random_thread_id() -> str:
    # Thread IDs don't need to be secure and any random generator will suffice.
    # Still, using secrets.token_hex() doesn't cost us much.
    return secrets.token_hex(THREAD_ID_HEX_LEN // 2)


def valid_tool_call_id(tool_call_id: str) -> bool:
    # This isn't intended as strict validation. It's just a basic
    # pass to avoid obvious garbage gets into the tracing system.
    return 0 < len(tool_call_id) <= TOOL_CALL_ID_MAX


def _emit_edge_record(thread_id: str, tool_call_id: str | None) -> None:
    pass

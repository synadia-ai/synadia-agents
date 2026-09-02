from __future__ import annotations

import json
import re
import secrets
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .identity.agent_id import AgentId

# Bump every time you change the trace record schema
# (be sure the TypeScript SDK is updated in lockstep)
EDGE_RECORD_VERSION = 3

# Default subject edge records are published to — the tenant-side short
# form; the account's import qualifies it.
DEFAULT_EDGE_SUBJECT = "TRACE.edges"

# Spelled out rather than `\s`, which means different things in the two
# languages: JavaScript's includes U+FEFF and Python's does not, Python's
# includes the C0 separators and JavaScript's does not. An explicit class
# is the only way the two SDKs reject exactly the same subjects.
_SUBJECT_FORBIDDEN = re.compile(
    "[\x00-\x20\x7f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
)


@dataclass(frozen=True, slots=True)
class TraceOptions:
    """Opt-in tracing configuration; passing an instance enables tracing.

    ``edge_subject`` is where edge records are published; ``None`` selects
    propagate-only mode — mint IDs and forward lineage, but publish no
    edge records.
    """

    edge_subject: str | None = DEFAULT_EDGE_SUBJECT

    def __post_init__(self) -> None:
        # Publishing is fail-open, so a subject that can never be published
        # to would only ever show up as a warning on every prompt. Fail at
        # construction instead.
        subject = self.edge_subject
        if subject is None:
            return
        if not isinstance(subject, str) or not subject:
            raise ValueError(f"edge_subject must be a non-empty subject or None (got {subject!r})")
        for token in subject.split("."):
            if not token:
                raise ValueError(f"edge_subject {subject!r} must not contain an empty token")
            if _SUBJECT_FORBIDDEN.search(token):
                raise ValueError(
                    f"edge_subject {subject!r} must not contain whitespace or control characters"
                )
            if "*" in token or ">" in token:
                raise ValueError(f"edge_subject {subject!r} must not contain wildcards")


THREAD_ID_HEX_LEN = 32
#: Longest accepted tool call id, in Unicode code points.
TOOL_CALL_ID_MAX = 256

_THREAD_ID_RE = re.compile(rf"[0-9a-f]{{{THREAD_ID_HEX_LEN}}}")


def is_thread_id(value: str) -> bool:
    """``True`` iff ``value`` has the shape of a thread ID.

    Exactly :data:`THREAD_ID_HEX_LEN` lowercase hex characters. Ids arriving
    on the wire are untrusted input that ends up in the headers an agent
    stamps on its model requests, so a receiver adopts nothing that is not
    shaped exactly like what the SDKs mint.
    """
    return _THREAD_ID_RE.fullmatch(value) is not None


@dataclass(frozen=True, slots=True)
class TraceScope:
    thread_id: str
    root_id: str
    # Where in this execution any thread it spawns next was sent out: how
    # many times it has stamped trace headers on a model request so far.
    # Deliberately a mutable cell inside a frozen scope: a task spawned
    # inside the handler gets a copy of the context but shares this
    # object, so its turns count against the same execution.
    # Excluded from equality and hashing: a frozen dataclass advertises
    # itself as hashable, and a mutable field would make hash() raise. It
    # is running state, not identity — two scopes naming the same
    # execution are the same scope whatever their counters read.
    turn_count_hint: list[int] = field(default_factory=lambda: [0], compare=False)


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
    # `len()` counts code points, which is what the TypeScript SDK counts
    # too, so the two accept exactly the same ids.
    if not 0 < len(tool_call_id) <= TOOL_CALL_ID_MAX:
        return False
    # A lone surrogate has no UTF-8 form: the record could not be encoded,
    # and TypeScript rejects it for the same reason.
    try:
        tool_call_id.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def build_edge_record(
    agent: AgentId,
    thread_id: str,
    parent_id: str | None,
    root_id: str,
    tool_call_id: str | None,
    turn_count_hint: int,
) -> tuple[str, bytes]:
    # Returns the record id alongside the payload: the publisher stamps it
    # as Nats-Msg-Id so a stream de-duplicates a record it already stored.
    #
    # `agent` is the writer — the caller that spawned the thread, the
    # parent side of the edge — in canonical `{account}.{user}` form. It is
    # the same identity that signs the record's Agent-Sender header, so a
    # consumer can cross-check the body against the verified header.
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
        "agent": str(agent),
        "thread_id": thread_id,
        "parent_id": parent_id,
        "root_id": root_id,
        "tool_call_id": tool_call_id,
        "turn_count_hint": turn_count_hint,
    }
    # `ensure_ascii=False`: `JSON.stringify` writes non-ASCII text raw, and
    # the two SDKs must write byte-identical records.
    return record_id, json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

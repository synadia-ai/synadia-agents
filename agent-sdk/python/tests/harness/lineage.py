"""A small, generic lineage extension built on nothing but the SDKs' public hooks.

Test support, not SDK code — the Python twin of the TypeScript suite's
``test/support/lineage.ts``. It exists to prove the hooks can carry an
extension that needs every one of them:

- the caller side (a ``PromptInterceptor``) mints a node id per prompt and
  inherits root and parent from the ambient scope in its first phase,
  which adds the node and root to the envelope as two extra fields; its
  second phase — once the prompt is signed and certain to go out —
  publishes one signed record about it, whose id is the header's nonce and
  the ``Nats-Msg-Id``;
- the host side (a ``RequestInterceptor``) reads those fields back,
  refuses a half pair with ``400``, mints a root when there is none, and
  runs the handler inside the scope, so a client used inside the handler
  inherits it;
- ``heartbeat_extras`` reports how many records were published and
  dropped, on every heartbeat and status reply.

The field and header names are this module's own; the SDK knows none of
them.
"""

from __future__ import annotations

import contextlib
import json
import re
import secrets
from collections.abc import Iterator
from contextvars import ContextVar
from dataclasses import dataclass

from synadia_ai.agents import PromptExtras, PromptInterceptorContext, ProtocolError

from synadia_ai.agent_service import CallNext, RequestInterceptorContext

#: The envelope fields and the header the pair adds.
NODE_FIELD = "lineage_node"
ROOT_FIELD = "lineage_root"
NODE_HEADER = "Lineage-Node"

_ID = re.compile(r"[0-9a-f]{32}")


def _new_id() -> str:
    return secrets.token_hex(16)


@dataclass(frozen=True, slots=True)
class LineageScope:
    """One execution: its own node id and the id of its tree's root."""

    node: str
    root: str


@dataclass(slots=True)
class LineageCounts:
    published: int = 0
    dropped: int = 0
    adopted: int = 0
    minted: int = 0


@dataclass(frozen=True, slots=True)
class _PlannedRecord:
    """What phase one decides about the record phase two publishes."""

    node: str
    parent: str | None
    root: str
    label: str | None


class _Caller:
    def __init__(self, lineage: Lineage) -> None:
        self._lineage = lineage

    async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
        # Phase one decides everything and publishes nothing: the prompt
        # may still fail its size check or its identity at publish time.
        ambient = self._lineage.current()
        node = _new_id()
        root = ambient.root if ambient is not None else node
        label = ctx.context.get("label")
        planned = _PlannedRecord(
            node=node,
            parent=ambient.node if ambient is not None else None,
            root=root,
            label=label if isinstance(label, str) else None,
        )
        return PromptExtras(
            fields={NODE_FIELD: node, ROOT_FIELD: root},
            headers={NODE_HEADER: node},
            state=planned,
        )

    async def before_publish(
        self, ctx: PromptInterceptorContext, extras: PromptExtras | None
    ) -> None:
        # Phase two runs only for a prompt that goes out, immediately
        # before it: the record describes a prompt that was sent.
        lin = self._lineage
        assert extras is not None and isinstance(extras.state, _PlannedRecord)
        planned = extras.state
        if not ctx.identity.can_sign:
            # Readers ignore unsigned records: the record is owed and dropped.
            lin.counts.dropped += 1
            return
        try:
            record_id = _new_id()
            record = {
                "record_id": record_id,
                "agent": str(await ctx.identity.self_id()),
                "node": planned.node,
                "parent": planned.parent,
                "root": planned.root,
                "target": ctx.agent.instance_id,
                "label": planned.label,
            }
            await ctx.identity.publish_signed(
                lin.record_subject, json.dumps(record), nonce=record_id
            )
            lin.counts.published += 1
        except Exception:
            lin.counts.dropped += 1


class _Host:
    def __init__(self, lineage: Lineage) -> None:
        self._lineage = lineage

    async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
        lin = self._lineage
        extras = ctx.envelope.extras
        node, root = extras.get(NODE_FIELD), extras.get(ROOT_FIELD)
        if (node is None) != (root is None):
            raise ProtocolError(f"{NODE_FIELD} and {ROOT_FIELD} must be given together")
        if node is not None:
            if not (
                isinstance(node, str)
                and isinstance(root, str)
                and _ID.fullmatch(node)
                and _ID.fullmatch(root)
            ):
                raise ProtocolError(
                    f"{NODE_FIELD} and {ROOT_FIELD} must be 32 lowercase hex characters"
                )
            scope = LineageScope(node=node, root=root)
            lin.counts.adopted += 1
        else:
            minted = _new_id()
            scope = LineageScope(node=minted, root=minted)
            lin.counts.minted += 1
        with lin.within(scope):
            await call_next()


class Lineage:
    """One lineage extension publishing its records to ``record_subject``."""

    def __init__(self, record_subject: str) -> None:
        self.record_subject = record_subject
        self.counts = LineageCounts()
        self._scope: ContextVar[LineageScope | None] = ContextVar(
            f"lineage-{id(self)}", default=None
        )
        self.caller = _Caller(self)
        self.host = _Host(self)

    def current(self) -> LineageScope | None:
        """The scope bound around the running handler, if any."""
        return self._scope.get()

    @contextlib.contextmanager
    def within(self, scope: LineageScope) -> Iterator[None]:
        """Bind ``scope`` for the block, as the host side does around a handler."""
        token = self._scope.set(scope)
        try:
            yield
        finally:
            self._scope.reset(token)

    def heartbeat_extras(self) -> dict[str, object]:
        return {
            "lineage_published": self.counts.published,
            "lineage_dropped": self.counts.dropped,
        }

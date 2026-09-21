"""Prompt interceptors — the caller-side hook around :meth:`Agent.prompt`, in two phases.

Both phases run once per prompt, in the order the client lists the
interceptors, and see the same per-prompt context: the target agent, the
prompt text, the extra fields of an :class:`Envelope` the caller passed to
:meth:`Agent.prompt`, the opaque ``context`` the caller passed with it, the
connection, and signing with the prompting client's identity.

1. ``before_prompt(ctx)`` decides what the prompt carries: it returns extra
   envelope fields and extra headers, or ``None``, and has no side effects
   — the prompt may still fail after it (its identity at publish time, the
   size of the envelope its fields make).
2. ``before_publish(ctx, extras)``, optional, runs only once the prompt is
   certain to go out: after its ``Agent-Sender`` header is signed and its
   size checked, immediately before it is published. This is where an
   interceptor publishes messages of its own — signed through
   ``ctx.identity`` — so a message about a prompt describes one that went
   out, barring a transport failure. It receives what its own
   ``before_prompt`` returned, ``state`` included, so an interceptor keeps
   nothing between the phases itself.

The SDK gives those fields and headers no meaning. §5.6 obliges a receiver
to tolerate unknown top-level envelope fields; a host built on
:mod:`synadia_ai.agent_service` reads them back from
:attr:`Envelope.extras` and the request's headers in its own request
interceptors. The caller's envelope's own extra fields go out too (a
relay preserves them, §5.6); an interceptor's field of the same name
replaces one.

When they run: at publish time, on the stream's first ``__anext__``, so a
prompt that is never iterated, or that :meth:`Agent.prompt` itself
rejects, runs neither phase. Both run in one copy of the :mod:`contextvars` context
:meth:`Agent.prompt` was called in, not the one the stream happens to be
iterated in, so an interceptor that reads a ``ContextVar`` sees the
caller's value. The TypeScript SDK's ``PromptInterceptor`` is the same
hook.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING, Protocol

from ._logging import get_logger
from .errors import NatsAgentError
from .identity.options import Identity, self_id_for
from .identity.sender_header import AGENT_SENDER_HEADER
from .identity.signed_publish import signed_publish_headers, to_bytes

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from .agent import Agent
    from .identity.agent_id import AgentId

log = get_logger(__name__)


class PromptSigning:
    """Signing with the prompting client's identity.

    The one that signs the prompt's own ``Agent-Sender`` header; the same
    rules as the :class:`~synadia_ai.agents.Agents` methods of the same
    names.
    """

    def __init__(self, nc: NATSClient, identity: Identity | None) -> None:
        self._nc = nc
        self._identity = identity

    @property
    def can_sign(self) -> bool:
        """``True`` iff a signer is configured, so :meth:`publish_signed` can sign."""
        return self._identity is not None and self._identity.signer is not None

    async def self_id(self) -> AgentId:
        """The client's own agent ID (``{account}.{user}``), as ``Agents.self_id()``."""
        return await self_id_for(self._identity, self._nc)

    async def publish_signed(
        self,
        subject: str,
        payload: bytes | str,
        *,
        sub: str | None = None,
        headers: Mapping[str, str] | None = None,
        nonce: str | None = None,
    ) -> None:
        """Sign and publish one message, as ``Agents.publish_signed()``.

        Its ``Agent-Sender`` header, and ``Nats-Msg-Id`` set to the nonce.
        Pass ``nonce`` for a body that carries its own id.
        """
        data = to_bytes(payload)
        hdrs = await signed_publish_headers(
            self._identity, self._nc, subject, data, sub=sub, headers=headers, nonce=nonce
        )
        await self._nc.publish(subject, data, headers=hdrs)


@dataclass(frozen=True, slots=True)
class PromptInterceptorContext:
    """What a :class:`PromptInterceptor` sees."""

    #: The agent the prompt is addressed to.
    agent: Agent
    #: The prompt text.
    prompt: str
    #: The extra fields (:attr:`Envelope.extras`) of an envelope passed to
    #: ``Agent.prompt``, which go out with it; empty for a text prompt. A
    #: read-only copy: changing what it holds changes nothing sent. It never
    #: holds an interceptor's fields.
    envelope_extras: Mapping[str, object]
    #: ``Agent.prompt(context=...)``, verbatim; empty when the caller passed none.
    context: Mapping[str, object]
    #: The connection the prompt goes out on.
    connection: NATSClient
    #: Signing with the prompting client's identity.
    identity: PromptSigning


@dataclass(frozen=True, slots=True)
class PromptExtras:
    """What a :class:`PromptInterceptor` adds to the prompt, from its first phase.

    ``fields`` are extra top-level envelope fields, by wire name — a field
    the envelope defines (``prompt``, ``attachments``) is refused; one the
    caller's envelope also carries (``ctx.envelope_extras``) is replaced.
    ``headers`` are extra message headers — ``Agent-Sender`` belongs to the
    SDK and is refused. ``state`` is anything the interceptor wants back in
    its second phase: opaque to the SDK, never sent, handed to
    ``before_publish`` as returned.
    """

    fields: Mapping[str, object] = field(default_factory=dict)
    headers: Mapping[str, str] = field(default_factory=dict)
    state: object = None


class PromptInterceptor(Protocol):
    """A caller-side hook around each prompt, in two phases (see the module docstring).

    ``before_prompt`` is phase one: what the prompt carries, no side
    effects. An exception fails the prompt: it surfaces from the stream's
    first ``__anext__``, and nothing is sent.

    Phase two is an optional method, ``async def before_publish(self, ctx,
    extras) -> None``, looked up on the interceptor: it runs after the
    prompt's header is signed and its size checked, immediately before it
    is published — the place to publish messages of the interceptor's own.
    ``extras`` is what this interceptor's ``before_prompt`` returned for the
    same ``ctx``. An exception is logged and does not stop the prompt, which
    by then is due to go out. :class:`PublishingPromptInterceptor` types an
    interceptor that has it.
    """

    async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None: ...


class PublishingPromptInterceptor(PromptInterceptor, Protocol):
    """A :class:`PromptInterceptor` with the optional second phase."""

    async def before_publish(
        self, ctx: PromptInterceptorContext, extras: PromptExtras | None
    ) -> None: ...


EMPTY_CONTEXT: Mapping[str, object] = MappingProxyType({})


def read_only_extras(extras: Mapping[str, object]) -> Mapping[str, object]:
    """``extras`` as :attr:`PromptInterceptorContext.envelope_extras` shows them.

    A deep copy behind a read-only mapping, so an interceptor that changes a
    nested value changes nothing sent.
    """
    return MappingProxyType(copy.deepcopy(dict(extras))) if extras else EMPTY_CONTEXT


@dataclass(frozen=True, slots=True)
class CollectedExtras:
    """The interceptors' first-phase additions, merged, and what each returned."""

    fields: Mapping[str, object]
    headers: Mapping[str, str]
    #: Each interceptor's ``before_prompt`` result, in order, for its ``before_publish``.
    results: tuple[PromptExtras | None, ...]


async def collect_extras(
    interceptors: tuple[PromptInterceptor, ...],
    ctx: PromptInterceptorContext,
    envelope_fields: frozenset[str],
) -> CollectedExtras:
    """Phase one: run ``interceptors`` in order and merge what they add.

    A later one wins a key an earlier one also set. A field in
    ``envelope_fields`` (the ones the envelope codec owns), or the
    ``Agent-Sender`` header, is refused rather than silently dropped: an
    interceptor that sets one has a bug worth hearing about.
    """
    fields: dict[str, object] = {}
    headers: dict[str, str] = {}
    results: list[PromptExtras | None] = []
    for interceptor in interceptors:
        extras = await interceptor.before_prompt(ctx)
        results.append(extras)
        if extras is None:
            continue
        for key, value in extras.fields.items():
            if key in envelope_fields:
                raise NatsAgentError(f"prompt interceptor: envelope field `{key}` is not an extra")
            fields[key] = value
        for key, value in extras.headers.items():
            if key.lower() == AGENT_SENDER_HEADER.lower():
                raise NatsAgentError(
                    f"prompt interceptor: the {AGENT_SENDER_HEADER} header is the SDK's"
                )
            headers[key] = value
    return CollectedExtras(fields=fields, headers=headers, results=tuple(results))


async def run_before_publish(
    interceptors: tuple[PromptInterceptor, ...],
    ctx: PromptInterceptorContext,
    results: tuple[PromptExtras | None, ...],
    subject: str,
) -> None:
    """Phase two: each interceptor's ``before_publish``, with what its phase one returned.

    The prompt is due to go out by now, so an exception stops neither it
    nor the interceptors after the one that raised: it is logged (the
    interceptor is application code, so its exception is not).
    """
    for index, (interceptor, extras) in enumerate(zip(interceptors, results, strict=True)):
        hook = getattr(interceptor, "before_publish", None)
        if hook is None:
            continue
        try:
            await hook(ctx, extras)
        except Exception:
            log.error(
                "prompt interceptor %d before_publish failed on %s; publishing the prompt",
                index,
                subject,
            )


__all__ = [
    "PromptExtras",
    "PromptInterceptor",
    "PromptInterceptorContext",
    "PromptSigning",
    "PublishingPromptInterceptor",
]

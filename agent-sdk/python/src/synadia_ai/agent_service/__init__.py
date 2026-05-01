"""Python agent-host SDK for the NATS Agent Protocol.

See https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md
for the wire spec; the §12 implementation checklist is what
``AgentService`` enforces.

Public API:

* :class:`AgentService` — protocol-compliant agent registration:
  service registration (§3), prompt endpoint (§5), status endpoint
  (v0.3 §-TBD), response-stream emission (§6), mid-stream queries
  (§7), heartbeat publisher (§8.3).
* :class:`PromptStream` — handle given to a prompt handler for
  emitting response chunks and asking mid-stream questions.
* :class:`PromptHandler` — type alias for ``Callable[[Envelope,
  PromptStream], Awaitable[None]]``.
* :data:`DEFAULT_MAX_PAYLOAD`, :data:`DEFAULT_KEEPALIVE_INTERVAL_S`,
  :data:`DEFAULT_ATTACHMENTS_OK` — agent-side defaults exposed for
  agent harnesses and tests.

Shared wire types — :class:`~synadia_ai.agents.Envelope`,
:class:`~synadia_ai.agents.HeartbeatPayload`,
:class:`~synadia_ai.agents.AgentSubject`, error classes, discovery
constants — live in the sibling distribution
:mod:`synadia_ai.agents`. Import them from there.

The SDK does NOT open NATS connections — callers build a
:class:`~nats.aio.client.Client` and hand it to
:class:`AgentService`. ``AgentService.stop()`` tears down SDK-owned
state only; the caller is responsible for ``nc.close()``.
"""

from __future__ import annotations

from .service import (
    DEFAULT_ATTACHMENTS_OK,
    DEFAULT_KEEPALIVE_INTERVAL_S,
    DEFAULT_MAX_PAYLOAD,
    AgentService,
    PromptHandler,
    PromptStream,
)

__all__ = [
    "DEFAULT_ATTACHMENTS_OK",
    "DEFAULT_KEEPALIVE_INTERVAL_S",
    "DEFAULT_MAX_PAYLOAD",
    "AgentService",
    "PromptHandler",
    "PromptStream",
]

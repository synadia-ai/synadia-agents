"""Python agent-host SDK for the Synadia Agent Protocol for NATS.

See https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md
for the wire spec; the §12 implementation checklist is what
``AgentService`` enforces.

Public API:

* :class:`AgentService` — protocol-compliant agent registration:
  service registration (§3), prompt endpoint (§5), status endpoint
  (v0.3 §-TBD), response-stream emission (§6), mid-stream queries
  (§7), heartbeat publisher (§8.3), and the receiver side of the
  sender-identity extension (classification before the ack,
  ``min_sender_trust``, the acceptance hook, registration metadata).
* :class:`PromptStream` — handle given to a prompt handler for
  emitting response chunks and asking mid-stream questions; carries the
  classified :attr:`PromptStream.sender`.
* :class:`PromptHandler` — type alias for ``Callable[[Envelope,
  PromptStream], Awaitable[None]]``.
* :class:`ServiceIdentity` — ``AgentService(identity=ServiceIdentity(signer=…))``,
  the host's own signer (registers ``id_sig``).
* :data:`AcceptSenderHook`, :class:`SenderGate`, :class:`NonceCache`,
  :class:`SenderAdmission`, :class:`SenderRejection` — the stateful
  classification parts, exposed for hand-rolled services.
* :data:`DEFAULT_MAX_PAYLOAD`, :data:`DEFAULT_KEEPALIVE_INTERVAL_S`,
  :data:`DEFAULT_ATTACHMENTS_OK`, :data:`DEFAULT_MIN_SENDER_TRUST`,
  :data:`DEFAULT_REPLAY_WINDOW_S`, :data:`DEFAULT_NONCE_CACHE_MAX_ENTRIES`
  — agent-side defaults exposed for agent harnesses and tests.

Shared wire types — :class:`~synadia_ai.agents.Envelope`,
:class:`~synadia_ai.agents.HeartbeatPayload`,
:class:`~synadia_ai.agents.AgentSubject`, error classes, discovery
constants — and the sender-identity codec (``SenderInfo`` /
``VerifiedSender`` / ``ClaimedSender``, ``format_sender``, ``AgentId``,
the ``signer_from_*`` helpers, ``verify_sender``) live in the sibling
distribution :mod:`synadia_ai.agents`. Import them from there; this
package does not re-export them.

The SDK does NOT open NATS connections — callers build a
:class:`~nats.aio.client.Client` and hand it to
:class:`AgentService`. ``AgentService.stop()`` tears down SDK-owned
state only; the caller is responsible for ``nc.close()``.
"""

from __future__ import annotations

from .identity import (
    DEFAULT_MIN_SENDER_TRUST,
    DEFAULT_NONCE_CACHE_MAX_ENTRIES,
    DEFAULT_REPLAY_WINDOW_S,
    AcceptSenderHook,
    NonceCache,
    SenderAdmission,
    SenderGate,
    SenderRejection,
    ServiceIdentity,
)
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
    "DEFAULT_MIN_SENDER_TRUST",
    "DEFAULT_NONCE_CACHE_MAX_ENTRIES",
    "DEFAULT_REPLAY_WINDOW_S",
    "AcceptSenderHook",
    "AgentService",
    "NonceCache",
    "PromptHandler",
    "PromptStream",
    "SenderAdmission",
    "SenderGate",
    "SenderRejection",
    "ServiceIdentity",
]

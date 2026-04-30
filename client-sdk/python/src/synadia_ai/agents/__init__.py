"""Python SDK for the NATS Agent Protocol.

See https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md
for the wire spec.

Public API entry points:

* :class:`Agents` — caller-side; owns the heartbeat wildcard, hands out
  live :class:`Agent` instances from :meth:`Agents.discover`.
* :class:`Agent` — a discovered agent with flat ``$SRV.INFO`` metadata
  fields and a :meth:`Agent.prompt` method.
* :func:`load_context_options` — translate a ``nats`` CLI context into
  kwargs for :func:`nats.connect`.
* :func:`parse_nats_url` — parse a NATS URL (with optional userinfo
  for token / user:password) into kwargs for :func:`nats.connect`.

The agent-host surface (``AgentService``, ``PromptStream``,
``PromptHandler``) lives in the sibling package
:mod:`synadia_ai.agent_service` (distribution
``synadia-ai-agent-service``); install that package alongside this one
when authoring an agent harness.

The SDK does NOT open NATS connections — callers build a
:class:`~nats.aio.client.Client` and hand it to :class:`Agents`. This
matches the TS SDK's PR #7 surface and the broader ``@nats-io/*``
convention (``jetstream(nc)``, ``Svcm(nc)``, ``Kvm(nc)``…).
"""

from __future__ import annotations

from .agent import (
    DEFAULT_STREAM_INACTIVITY_TIMEOUT_S,
    Agent,
    Query,
    StreamMessage,
)
from .agents import Agents
from .context import load_context_options, parse_nats_url
from .discovery import (
    DEFAULT_DISCOVER_MAX_WAIT_S,
    DEFAULT_DISCOVER_STALL_S,
    PROMPT_ENDPOINT_NAME,
    PROMPT_QUEUE_GROUP,
    SERVICE_NAME,
    STATUS_ENDPOINT_NAME,
    STATUS_QUEUE_GROUP,
    AgentInfo,
    DiscoverFilter,
    EndpointInfo,
    build_agent_info,
)
from .envelope import Attachment, Envelope, decode, encode
from .errors import (
    AgentNotFound,
    AttachmentsNotSupportedError,
    InvalidSubjectToken,
    NatsAgentError,
    NatsContextError,
    PayloadTooLargeError,
    PromptEmptyError,
    ProtocolError,
    QueryTimeout,
    ValidationError,
)
from .heartbeat import (
    DEFAULT_LIVENESS_SLACK,
    HEARTBEAT_SUBJECT,
    HeartbeatPayload,
    Liveness,
)
from .messages import Chunk, QueryChunk, ResponseChunk, StatusChunk
from .subjects import AgentSubject

__all__ = [
    "DEFAULT_DISCOVER_MAX_WAIT_S",
    "DEFAULT_DISCOVER_STALL_S",
    "DEFAULT_LIVENESS_SLACK",
    "DEFAULT_STREAM_INACTIVITY_TIMEOUT_S",
    "HEARTBEAT_SUBJECT",
    "PROMPT_ENDPOINT_NAME",
    "PROMPT_QUEUE_GROUP",
    "SERVICE_NAME",
    "STATUS_ENDPOINT_NAME",
    "STATUS_QUEUE_GROUP",
    "Agent",
    "AgentInfo",
    "AgentNotFound",
    "AgentSubject",
    "Agents",
    "Attachment",
    "AttachmentsNotSupportedError",
    "Chunk",
    "DiscoverFilter",
    "EndpointInfo",
    "Envelope",
    "HeartbeatPayload",
    "InvalidSubjectToken",
    "Liveness",
    "NatsAgentError",
    "NatsContextError",
    "PayloadTooLargeError",
    "PromptEmptyError",
    "ProtocolError",
    "Query",
    "QueryChunk",
    "QueryTimeout",
    "ResponseChunk",
    "StatusChunk",
    "StreamMessage",
    "ValidationError",
    "build_agent_info",
    "decode",
    "encode",
    "load_context_options",
    "parse_nats_url",
]

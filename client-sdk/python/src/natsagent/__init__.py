"""Python SDK for the NATS Agent Protocol.

See https://github.com/synadia-ai/nats-agent-sdk-docs/blob/main/core-protocol.md
for the wire spec. Public API enters at :class:`Client` (caller-side)
and :class:`Agent` (agent-side). :func:`connect` is the blessed
connection factory — direct URL, CLI context, or passthrough.
"""

from __future__ import annotations

from .agent import Agent, PromptHandler, PromptStream
from .client import Client, DiscoveredAgent, EndpointInfo, Query, RemoteAgent, StreamMessage
from .connect import NatsContext, connect
from .envelope import Attachment, Envelope, decode, encode
from .errors import (
    AgentNotFound,
    AttachmentsNotSupportedError,
    ContextInvalidError,
    ContextNotFoundError,
    ContextNotSelectedError,
    ContextNotSupportedError,
    InvalidSubjectToken,
    NatsAgentError,
    PayloadTooLargeError,
    PromptEmptyError,
    ProtocolError,
    QueryTimeout,
    ValidationError,
)
from .heartbeat import AgentStatus, HeartbeatPayload
from .messages import Chunk, QueryChunk, ResponseChunk, StatusChunk
from .subjects import AgentSubject

__all__ = [
    "Agent",
    "AgentNotFound",
    "AgentStatus",
    "AgentSubject",
    "Attachment",
    "AttachmentsNotSupportedError",
    "Chunk",
    "Client",
    "ContextInvalidError",
    "ContextNotFoundError",
    "ContextNotSelectedError",
    "ContextNotSupportedError",
    "DiscoveredAgent",
    "EndpointInfo",
    "Envelope",
    "HeartbeatPayload",
    "InvalidSubjectToken",
    "NatsAgentError",
    "NatsContext",
    "PayloadTooLargeError",
    "PromptEmptyError",
    "PromptHandler",
    "PromptStream",
    "ProtocolError",
    "Query",
    "QueryChunk",
    "QueryTimeout",
    "RemoteAgent",
    "ResponseChunk",
    "StatusChunk",
    "StreamMessage",
    "ValidationError",
    "connect",
    "decode",
    "encode",
]

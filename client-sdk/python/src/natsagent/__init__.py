"""Python SDK for the NATS Agent Protocol.

See https://github.com/synadia-ai/nats-agent-sdk-docs for the wire spec. Public API enters at :class:`Client` (caller-side) and :class:`Agent`
(agent-side).
"""

from __future__ import annotations

from .agent import Agent, PromptHandler, PromptStream
from .client import Client, DiscoveredAgent, EndpointInfo, Query, RemoteAgent, StreamMessage
from .envelope import Attachment, Envelope, decode, encode
from .errors import (
    AgentNotFound,
    AttachmentsNotSupportedError,
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
    "DiscoveredAgent",
    "EndpointInfo",
    "Envelope",
    "HeartbeatPayload",
    "InvalidSubjectToken",
    "NatsAgentError",
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
    "decode",
    "encode",
]

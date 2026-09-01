"""Python SDK for the Synadia Agent Protocol for NATS.

See https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md
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
* :func:`resolve_nats_connection_bundle` — snapshot connection auth once
  and optionally derive a sender signer from that same source.
* :class:`Identity` + the ``signer_from_*`` helpers — the sender-identity
  extension (optional ``Agent-Sender`` on ``prompt`` / ``status`` requests,
  ``Agents.self_id()``, the signed wrappers); the shared codec lives in
  :mod:`synadia_ai.agents.identity` and is re-exported here.

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
    DEFAULT_PROMPT_MAX_WAIT_S,
    DEFAULT_STATUS_TIMEOUT_S,
    DEFAULT_STREAM_INACTIVITY_TIMEOUT_S,
    Agent,
    Query,
    StreamMessage,
)
from .agents import DEFAULT_REQUEST_SIGNED_TIMEOUT_S, NATS_MSG_ID_HEADER, Agents
from .connection_bundle import (
    CredentialSource,
    IdentityMode,
    NatsConnectionBundle,
    resolve_nats_connection_bundle,
)
from .context import NatsContextFile, load_context_options, parse_nats_url, read_context_file
from .discovery import (
    DEFAULT_DISCOVER_MAX_WAIT_S,
    DEFAULT_DISCOVER_STALL_S,
    MIN_SENDER_TRUST_KEY,
    PROMPT_ENDPOINT_NAME,
    PROMPT_QUEUE_GROUP,
    SERVICE_NAME,
    STATUS_ENDPOINT_NAME,
    STATUS_QUEUE_GROUP,
    AgentInfo,
    DiscoverFilter,
    EndpointInfo,
    MinSenderTrust,
    build_agent_info,
    parse_min_sender_trust,
)
from .envelope import Attachment, Envelope, decode, encode
from .errors import (
    AgentNotFound,
    AgentsClosedError,
    AttachmentsNotSupportedError,
    IdentityError,
    IdentityMismatchError,
    IdentityUnavailableError,
    InvalidAgentIdError,
    InvalidSubjectToken,
    MalformedSenderHeaderError,
    NatsAgentError,
    NatsContextError,
    NoIdentityError,
    PayloadTooLargeError,
    PromptEmptyError,
    ProtocolError,
    QueryTimeout,
    SenderSignatureRequiredError,
    SenderVerificationError,
    StreamMaxWaitExceededError,
    StreamStalledError,
    ValidationError,
)
from .heartbeat import (
    DEFAULT_LIVENESS_SLACK,
    HEARTBEAT_SUBJECT,
    HeartbeatPayload,
    Liveness,
)
from .identity import (
    AGENT_ID_SIGNED_INPUT_TAG,
    AGENT_SENDER_HEADER,
    AGENT_SENDER_SIGNED_INPUT_TAG,
    DEFAULT_REPLAY_WINDOW_S,
    DEFAULT_RESOLVE_TTL_S,
    IDENTITY_METADATA_KEYS,
    NATS_REQUEST_INFO_HEADER,
    SELF_ID_NEGATIVE_TTL_S,
    SELF_ID_TIMEOUT_S,
    SENDER_REJECTED_DESCRIPTION,
    SIGNATURE_REQUIRED_DESCRIPTION,
    USER_INFO_SUBJECT,
    AgentId,
    AgentSenderHeader,
    ClaimedSender,
    Identity,
    NkeySigner,
    NonceSeen,
    SenderClaim,
    SenderInfo,
    SenderResolver,
    SenderSigner,
    VerifiedSender,
    VerifyMode,
    build_claim_header,
    build_signed_input,
    check_subject_acceptance,
    encoded_header_length,
    expected_sender_header_bytes,
    format_sender,
    format_sender_timestamp,
    max_sender_header_bytes,
    normalize_account_token_position,
    parse_sender_header,
    peek_self_id,
    read_sender_header_value,
    refresh_self_id,
    resolve_sender,
    self_id,
    serialize_sender_header,
    sign_agent_id,
    sign_sender_header,
    signer_from_context,
    signer_from_creds,
    signer_from_creds_file,
    signer_from_seed,
    verify_agent_id,
    verify_sender,
    verify_sender_header,
)
from .messages import Chunk, QueryChunk, ResponseChunk, StatusChunk
from .subjects import AgentSubject

__all__ = [
    "AGENT_ID_SIGNED_INPUT_TAG",
    "AGENT_SENDER_HEADER",
    "AGENT_SENDER_SIGNED_INPUT_TAG",
    "DEFAULT_DISCOVER_MAX_WAIT_S",
    "DEFAULT_DISCOVER_STALL_S",
    "DEFAULT_LIVENESS_SLACK",
    "DEFAULT_PROMPT_MAX_WAIT_S",
    "DEFAULT_REPLAY_WINDOW_S",
    "DEFAULT_REQUEST_SIGNED_TIMEOUT_S",
    "DEFAULT_RESOLVE_TTL_S",
    "DEFAULT_STATUS_TIMEOUT_S",
    "DEFAULT_STREAM_INACTIVITY_TIMEOUT_S",
    "HEARTBEAT_SUBJECT",
    "IDENTITY_METADATA_KEYS",
    "MIN_SENDER_TRUST_KEY",
    "NATS_MSG_ID_HEADER",
    "NATS_REQUEST_INFO_HEADER",
    "PROMPT_ENDPOINT_NAME",
    "PROMPT_QUEUE_GROUP",
    "SELF_ID_NEGATIVE_TTL_S",
    "SELF_ID_TIMEOUT_S",
    "SENDER_REJECTED_DESCRIPTION",
    "SERVICE_NAME",
    "SIGNATURE_REQUIRED_DESCRIPTION",
    "STATUS_ENDPOINT_NAME",
    "STATUS_QUEUE_GROUP",
    "USER_INFO_SUBJECT",
    "Agent",
    "AgentId",
    "AgentInfo",
    "AgentNotFound",
    "AgentSenderHeader",
    "AgentSubject",
    "Agents",
    "AgentsClosedError",
    "Attachment",
    "AttachmentsNotSupportedError",
    "Chunk",
    "ClaimedSender",
    "CredentialSource",
    "DiscoverFilter",
    "EndpointInfo",
    "Envelope",
    "HeartbeatPayload",
    "Identity",
    "IdentityError",
    "IdentityMismatchError",
    "IdentityMode",
    "IdentityUnavailableError",
    "InvalidAgentIdError",
    "InvalidSubjectToken",
    "Liveness",
    "MalformedSenderHeaderError",
    "MinSenderTrust",
    "NatsAgentError",
    "NatsConnectionBundle",
    "NatsContextError",
    "NatsContextFile",
    "NkeySigner",
    "NoIdentityError",
    "NonceSeen",
    "PayloadTooLargeError",
    "PromptEmptyError",
    "ProtocolError",
    "Query",
    "QueryChunk",
    "QueryTimeout",
    "ResponseChunk",
    "SenderClaim",
    "SenderInfo",
    "SenderResolver",
    "SenderSignatureRequiredError",
    "SenderSigner",
    "SenderVerificationError",
    "StatusChunk",
    "StreamMaxWaitExceededError",
    "StreamMessage",
    "StreamStalledError",
    "ValidationError",
    "VerifiedSender",
    "VerifyMode",
    "build_agent_info",
    "build_claim_header",
    "build_signed_input",
    "check_subject_acceptance",
    "decode",
    "encode",
    "encoded_header_length",
    "expected_sender_header_bytes",
    "format_sender",
    "format_sender_timestamp",
    "load_context_options",
    "max_sender_header_bytes",
    "normalize_account_token_position",
    "parse_min_sender_trust",
    "parse_nats_url",
    "parse_sender_header",
    "peek_self_id",
    "read_context_file",
    "read_sender_header_value",
    "refresh_self_id",
    "resolve_nats_connection_bundle",
    "resolve_sender",
    "self_id",
    "serialize_sender_header",
    "sign_agent_id",
    "sign_sender_header",
    "signer_from_context",
    "signer_from_creds",
    "signer_from_creds_file",
    "signer_from_seed",
    "verify_agent_id",
    "verify_sender",
    "verify_sender_header",
]

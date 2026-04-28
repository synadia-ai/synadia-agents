// @synadia-ai/agents — TypeScript SDK for the NATS Agent Protocol.
//
// Public API for callers:
//   - {@link Agents}              — construct with a `NatsConnection`.
//   - {@link Agents.discover}     — enumerate agents; returns a live `Agent[]`.
//   - {@link Agent.prompt}        — stream a prompt to an agent.
//
// Public API for agent authors (v0.3):
//   - {@link AgentService}        — register a protocol-compliant agent
//                                   (prompt + status endpoints, heartbeat
//                                   loop, per-request keep-alive, terminator).
//   - {@link AgentSubject}        — verb-first subject builder shared
//                                   between SDK, agent harnesses, and
//                                   examples.
//
// Subpath entry points:
//   - `@synadia-ai/agents/errors`  — error class hierarchy for `instanceof`.
//   - `@synadia-ai/agents/testing` — spec-compliant reference agent for tests.

export { Agents, DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS, type AgentsOptions } from "./agents.js";

/** Re-export from `@nats-io/nats-core` for callers using the hard path. */
export type { NatsConnection } from "@nats-io/nats-core";
export { Agent } from "./agent.js";

// Discovery
export { type AgentInfo, type RawServiceInfo, buildAgentInfo } from "./discovery/agent-info.js";
export { type EndpointInfo, PROMPT_ENDPOINT_NAME } from "./discovery/endpoint-info.js";
export {
  type DiscoveryFilter,
  type DiscoverOptions,
  DEFAULT_DISCOVER_MAX_WAIT_MS,
  DEFAULT_DISCOVER_STALL_MS,
} from "./discovery/srv-ping.js";
export {
  SERVICE_NAME,
  PROMPT_QUEUE_GROUP,
  STATUS_ENDPOINT_NAME,
  STATUS_QUEUE_GROUP,
} from "./internal/service-name.js";

// Subjects (v0.3 — verb-first)
export {
  AgentSubject,
  InvalidSubjectTokenError,
  isHeartbeatSubject,
  isRecommendedToken,
  parseAgentSubject,
  RESERVED_VERBS,
  SUBJECT_ROOT,
  VERB_ATTACHMENTS,
  VERB_HEARTBEAT,
  VERB_PROMPT,
  VERB_STATUS,
  type ParseAgentSubjectOptions,
} from "./subjects.js";

// Agent service (server-side helper for agent authors)
export {
  AgentService,
  PromptResponse,
  DEFAULT_ATTACHMENTS_OK,
  DEFAULT_HEARTBEAT_INTERVAL_S,
  DEFAULT_KEEPALIVE_INTERVAL_S,
  DEFAULT_MAX_PAYLOAD,
  type AgentServiceOptions,
  type PromptHandler,
} from "./service.js";

// Liveness
export {
  type BuildHeartbeatPayloadOptions,
  type HeartbeatPayload,
  buildHeartbeatPayload,
  encodeHeartbeatPayload,
} from "./heartbeat/payload.js";
export { type Liveness, DEFAULT_LIVENESS_SLACK, HEARTBEAT_SUBJECT } from "./heartbeat/tracker.js";

// Prompt + streaming
export {
  type RequestEnvelope,
  type RequestAttachment,
  decodeEnvelope,
  decodeStrictBase64,
  encodeBase64,
  decodeBase64,
} from "./prompt/envelope.js";
export {
  encodeChunk,
  type Chunk,
  type ResponseChunk,
  type StatusChunk,
  type QueryChunk,
} from "./stream/chunk-encoder.js";
export {
  type AttachmentInput,
  normalizeAttachment,
  normalizeAttachments,
} from "./prompt/attachments.js";
export { type PromptOptions } from "./prompt/options.js";
export {
  PromptStream,
  type StreamMessage,
  type ResponseAttachment,
} from "./stream/prompt-stream.js";
export { type QueryEvent, QueryAlreadyRepliedError } from "./query/query-event.js";
export { type DecodedAttachment } from "./stream/chunk-decoder.js";

// Errors
export {
  NatsAgentError,
  ValidationError,
  PromptEmptyError,
  AttachmentsNotSupportedError,
  PayloadTooLargeError,
  ServiceError,
  StreamStalledError,
  ProtocolError,
  NatsContextError,
  type ServiceErrorBody,
} from "./errors.js";

// Logging
export { type Logger, SILENT_LOGGER } from "./internal/logger.js";

// NATS CLI context loader
export { loadContextOptions } from "./context.js";

// Version metadata
export {
  SDK_PROTOCOL_VERSION,
  type ProtocolVersion,
  type VersionCompatibility,
} from "./version.js";

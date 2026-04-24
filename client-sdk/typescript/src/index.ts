// @synadia/agents — TypeScript SDK for the NATS Agent Protocol.
//
// Public API:
//   - {@link Agents}              — construct with a `NatsConnection`.
//   - {@link Agents.discover}     — enumerate agents; returns a live `Agent[]`.
//   - {@link Agent.prompt}        — stream a prompt to an agent.
//
// Subpath entry points:
//   - `@synadia/agents/errors`  — error class hierarchy for `instanceof`.
//   - `@synadia/agents/testing` — spec-compliant reference agent and harness.

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
export { SERVICE_NAME, PROMPT_QUEUE_GROUP } from "./internal/service-name.js";

// Liveness
export { type HeartbeatPayload } from "./heartbeat/payload.js";
export { type Liveness, DEFAULT_LIVENESS_SLACK, HEARTBEAT_SUBJECT } from "./heartbeat/tracker.js";

// Prompt + streaming
export {
  type RequestEnvelope,
  type RequestAttachment,
  encodeBase64,
  decodeBase64,
} from "./prompt/envelope.js";
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
  type ServiceErrorBody,
} from "./errors.js";

// NATS CLI context loader (optional helper — callers still own their NatsConnection)
export { loadNatsContext, type LoadedNatsContext } from "./context.js";

// Logging
export { type Logger, SILENT_LOGGER } from "./internal/logger.js";

// Version metadata
export {
  SDK_PROTOCOL_VERSION,
  type ProtocolVersion,
  type VersionCompatibility,
} from "./version.js";

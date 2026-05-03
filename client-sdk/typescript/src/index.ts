// @synadia-ai/agents — TypeScript SDK for the NATS Agent Protocol.
//
// Public API for callers:
//   - {@link Agents}              — construct with a `NatsConnection`.
//   - {@link Agents.discover}     — enumerate agents; returns a live `Agent[]`.
//   - {@link Agent.prompt}        — stream a prompt to an agent.
//
// Shared building blocks (used by both callers and agent authors):
//   - {@link AgentSubject}        — verb-first subject builder shared
//                                   between SDK, agent harnesses, and
//                                   examples.
//   - {@link HeartbeatTracker}    — wildcard liveness watcher.
//   - Wire codecs (decoder side), envelope helpers, error hierarchy.
//
// Subpath entry points:
//   - `@synadia-ai/agents/errors`  — error class hierarchy for `instanceof`.
//
// Hosting an agent? Install the sister package
// `@synadia-ai/agent-service` for `AgentService`, `ReferenceAgent`, and
// the host-side wire helpers.

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
  type AgentSubjectOptions,
  type ParseAgentSubjectOptions,
} from "./subjects.js";

// Liveness — caller-side type + decoder. The encoder side
// (`buildHeartbeatPayload`, `encodeHeartbeatPayload`) lives in the host
// SDK at `@synadia-ai/agent-service`.
export { type HeartbeatPayload, decodeHeartbeatPayload } from "./heartbeat/payload.js";
export {
  type Liveness,
  DEFAULT_LIVENESS_SLACK,
  HEARTBEAT_SUBJECT,
  HeartbeatTracker,
} from "./heartbeat/tracker.js";

// Byte-size grammar helpers (§2.1 `\d+(B|KB|MB|GB)`).
export { formatHumanBytes, parseHumanBytes, InvalidSizeError } from "./bytes.js";

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
  type AttachmentInput,
  normalizeAttachment,
  normalizeAttachments,
} from "./prompt/attachments.js";
export { type PromptOptions, DEFAULT_PROMPT_MAX_WAIT_MS } from "./prompt/options.js";
export {
  PromptStream,
  type StreamMessage,
  type ResponseAttachment,
} from "./stream/prompt-stream.js";
export { type QueryEvent, QueryAlreadyRepliedError } from "./query/query-event.js";
export {
  type DecodedAttachment,
  type DecodedChunk,
  type DecodedQuery,
  type DecodedResponse,
  type DecodedStatus,
  decodeChunk,
} from "./stream/chunk-decoder.js";

// Errors
export {
  NatsAgentError,
  ValidationError,
  PromptEmptyError,
  AttachmentsNotSupportedError,
  PayloadTooLargeError,
  ServiceError,
  StreamStalledError,
  StreamMaxWaitExceededError,
  ProtocolError,
  NatsContextError,
  type ServiceErrorBody,
} from "./errors.js";

// Logging
export { type Logger, SILENT_LOGGER } from "./internal/logger.js";

/**
 * Reply-inbox factory. Re-exported for `@synadia-ai/agent-service` so the
 * host-side `PromptResponse.ask` round-trip uses the same `_INBOX.agents.>`
 * prefix as caller-side prompts. Internal contract — not part of the
 * documented caller API; subject to change without a major bump.
 *
 * @internal
 */
export { newInbox } from "./internal/inbox.js";

// NATS CLI context loader + URL parser (both produce NodeConnectionOptions)
export { loadContextOptions, parseNatsUrl } from "./context.js";

// Version metadata
export {
  SDK_PROTOCOL_VERSION,
  type ProtocolVersion,
  type VersionCompatibility,
} from "./version.js";

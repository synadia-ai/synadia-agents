// @synadia/agents — TypeScript SDK for the NATS Agent Protocol.
//
// Public API:
//   - {@link connect} / {@link attach}  — obtain a {@link Client}.
//   - {@link Client.discover}            — find agents on the NATS system.
//   - {@link Client.bind}                — get a {@link RemoteAgent} handle.
//   - {@link RemoteAgent.prompt}         — (M2+) stream a prompt to an agent.
//
// Subpath entry points:
//   - `@synadia/agents/errors`  — error class hierarchy for `instanceof`.
//   - `@synadia/agents/testing` — spec-compliant reference agent and harness.

export { connect, attach, type ConnectOptions, type AttachOptions } from "./connect.js";
export { Client, DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS, type ClientOptions } from "./client.js";

/** Re-export from `@nats-io/nats-core` for callers using the hard path. */
export type { NatsConnection } from "@nats-io/nats-core";
export { RemoteAgent } from "./remote-agent.js";

// Discovery
export {
  type DiscoveredAgent,
  type RawServiceInfo,
  buildDiscoveredAgent,
} from "./discovery/discovered-agent.js";
export { type EndpointInfo, PROMPT_ENDPOINT_NAME } from "./discovery/endpoint-info.js";
export { type DiscoveryFilter, type DiscoverOptions } from "./discovery/srv-ping.js";
export { SERVICE_NAME, PROMPT_QUEUE_GROUP } from "./internal/service-name.js";

// Liveness
export { type HeartbeatPayload } from "./heartbeat/payload.js";
export { type Liveness, type HeartbeatScope, DEFAULT_LIVENESS_SLACK } from "./heartbeat/tracker.js";

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
  NatsContextError,
  NatsContextNotFoundError,
  NatsContextNotSelectedError,
  NatsContextInvalidError,
  type ServiceErrorBody,
} from "./errors.js";

// NATS context loader (spec §10.2)
export { loadNatsContext, type NatsContext, type ContextSelector } from "./context.js";

// Logging
export { type Logger, SILENT_LOGGER } from "./internal/logger.js";

// Version metadata
export {
  SDK_PROTOCOL_VERSION,
  type ProtocolVersion,
  type VersionCompatibility,
} from "./version.js";

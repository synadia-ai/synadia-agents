// @synadia-ai/agents — TypeScript SDK for the Synadia Agent Protocol for NATS.
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

export {
  Agents,
  DEFAULT_REQUEST_SIGNED_TIMEOUT_MS,
  DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS,
  NATS_MSG_ID_HEADER,
  type AgentsOptions,
  type SignedPublishOptions,
  type SignedRequestOptions,
} from "./agents.js";

/** Re-export from `@nats-io/nats-core` for callers using the hard path. */
export type { NatsConnection } from "@nats-io/nats-core";
export { Agent } from "./agent.js";

// Discovery
export { type AgentInfo, type RawServiceInfo, buildAgentInfo } from "./discovery/agent-info.js";
export {
  type EndpointInfo,
  type MinSenderTrust,
  MIN_SENDER_TRUST_KEY,
  parseMinSenderTrust,
  PROMPT_ENDPOINT_NAME,
} from "./discovery/endpoint-info.js";
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
export {
  type PromptOptions,
  type StatusOptions,
  DEFAULT_PROMPT_MAX_WAIT_MS,
  DEFAULT_STATUS_TIMEOUT_MS,
} from "./prompt/options.js";
export {
  PromptStream,
  buildServiceErrorFromMsg,
  type PromptStreamOptions,
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
  IdentityError,
  NoIdentityError,
  IdentityUnavailableError,
  IdentityMismatchError,
  InvalidAgentIdError,
  MalformedSenderHeaderError,
  SenderSignatureRequiredError,
  SenderVerificationError,
  type ServiceErrorBody,
} from "./errors.js";

// Sender identity (extension — spec `agent-protocol-sender-identity.md`).
export {
  type AgentId,
  AGENT_ID_REGEX,
  agentIdAccount,
  agentIdUser,
  newAgentId,
  parseAgentId,
} from "./identity/agent-id.js";
export {
  type SenderSigner,
  type ParsedCreds,
  decodeJwtPayload,
  identityFromJwt,
  parseCreds,
  signerFromContext,
  signerFromCreds,
  signerFromCredsFile,
  signerFromSeed,
} from "./identity/signer.js";
export {
  type AgentSenderHeader,
  type ClaimedSender,
  type SenderInfo,
  type SignedInputFields,
  type SignSenderHeaderOptions,
  type VerifiableMsg,
  type VerifiedSender,
  type VerifySenderMsgOptions,
  type VerifySenderOptions,
  AGENT_SENDER_HEADER,
  AGENT_SENDER_SIGNED_INPUT_TAG,
  AGENT_SENDER_VERSION,
  DEFAULT_REPLAY_WINDOW_MS,
  MAX_SENDER_HEADER_VALUE_BYTES,
  MAX_SENDER_NAME_LENGTH,
  SENDER_HEADER_FRAMING_BYTES,
  SENDER_REJECTED_DESCRIPTION,
  SIGNATURE_REQUIRED_DESCRIPTION,
  assertValidSenderName,
  buildClaimHeader,
  buildSignedInput,
  checkSubjectAcceptance,
  encodedHeaderLength,
  expectedSenderHeaderBytes,
  formatSenderTimestamp,
  maxSenderHeaderBytes,
  normalizeAccountTokenPosition,
  parseSenderHeader,
  parseSenderTimestamp,
  readSenderHeaderValue,
  serializeSenderHeader,
  signSenderHeader,
  verifySender,
  verifySenderHeader,
} from "./identity/sender-header.js";
export {
  type RequestInfoStamp,
  NATS_REQUEST_INFO_HEADER,
  parseRequestInfo,
  readRequestInfo,
} from "./identity/request-info.js";
export {
  type SenderResolverOptions,
  DEFAULT_RESOLVE_TTL_MS,
  normalizeResolveTtlMs,
  resolveSender,
  SenderResolver,
} from "./identity/resolve-sender.js";
export {
  type AgentIdSignedInputFields,
  type SignAgentIdOptions,
  AGENT_ID_SIGNED_INPUT_TAG,
  IDENTITY_METADATA_KEYS,
  buildAgentIdSignedInput,
  signAgentId,
  verifyAgentId,
} from "./identity/id-sig.js";
export { formatSender } from "./identity/format.js";
export {
  type SelfIdOptions,
  type SelfIdSettled,
  SELF_ID_NEGATIVE_TTL_MS,
  SELF_ID_TIMEOUT_MS,
  USER_INFO_SUBJECT,
  identityFromUserInfoReply,
  lookupSelfId,
  peekSelfId,
  refreshSelfId,
  selfId,
} from "./identity/self-id.js";
export { type IdentityOptions } from "./identity/context.js";
export { base64UrlDecode, base64UrlEncode, sha256, sha256Hex } from "./identity/crypto.js";

// Observability tracing (opt-in)
export {
  DEFAULT_EDGE_SUBJECT,
  EDGE_RECORD_VERSION,
  THREAD_ID_HEX_LEN,
  TOOL_CALL_ID_MAX,
  activeTrace,
  bindActiveTrace,
  buildEdgeRecord,
  randomThreadId,
  validToolCallId,
  type TraceOptions,
  type TraceScope,
} from "./trace.js";

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
export {
  loadContextOptions,
  parseNatsUrl,
  readContextFile,
  type NatsContextFile,
} from "./context.js";

// One-snapshot connection credentials + optional sender signer.
export {
  resolveNatsConnectionBundle,
  type NatsConnectionBundle,
  type NatsConnectionSource,
  type NatsUrlConnectionSource,
  type ResolveNatsConnectionBundleOptions,
  type SignedNatsConnectionBundle,
} from "./connection-bundle.js";

// Opinionated reconnect defaults for agent runtimes — see #121.
export { AGENT_RECONNECT_DEFAULTS, withAgentReconnectDefaults } from "./connect-defaults.js";

// Version metadata
export {
  SDK_PROTOCOL_VERSION,
  InvalidProtocolVersionError,
  compareProtocolVersion,
  parseProtocolVersion,
  type ProtocolVersion,
  type VersionCompatibility,
} from "./version.js";

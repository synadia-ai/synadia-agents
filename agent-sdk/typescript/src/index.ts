// @synadia-ai/agent-service — server-side TypeScript SDK for the NATS Agent Protocol.
//
// Pairs with @synadia-ai/agents (caller-side). Agent harness authors install
// both packages — this one re-exports nothing from the caller, keeping the
// two-package boundary clean.
//
// Public API:
//   - {@link AgentService}     — register a protocol-compliant agent.
//                                Handles `prompt` + `status` endpoints,
//                                heartbeats, per-request keep-alive, and
//                                terminator emission.
//   - {@link AgentServiceOptions.extraEndpoints} / {@link AgentService.service}
//                                — extension points for custom endpoints
//                                  (e.g. controller `spawn`/`stop`/`list`).
//   - {@link encodeChunk}, {@link splitResponseText} — server-side wire
//                                helpers for emitting response chunks.
//   - {@link buildHeartbeatPayload}, {@link encodeHeartbeatPayload} —
//                                heartbeat-publisher helpers.
//
// Subpath entry points:
//   - `@synadia-ai/agent-service/testing` — the spec-compliant
//     {@link ReferenceAgent} for integration / interop tests.

export {
  AgentService,
  PromptResponse,
  DEFAULT_ATTACHMENTS_OK,
  DEFAULT_HEARTBEAT_INTERVAL_S,
  DEFAULT_KEEPALIVE_INTERVAL_S,
  DEFAULT_MAX_PAYLOAD,
  type AgentServiceExtraEndpoint,
  type AgentServiceOptions,
  type PromptHandler,
} from "./service.js";

export {
  type Chunk,
  type QueryChunk,
  type ResponseChunk,
  type StatusChunk,
  encodeChunk,
  splitResponseText,
} from "./stream/chunk-encoder.js";

export {
  type BuildHeartbeatPayloadOptions,
  buildHeartbeatPayload,
  encodeHeartbeatPayload,
} from "./heartbeat/payload.js";

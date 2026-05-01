# Changelog

All notable changes to `@synadia-ai/agent-service` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-05-XX

Initial release. Sister package to `@synadia-ai/agents` 0.4.0 — agent
harness authors install both. Created by splitting the host-side
surface out of `@synadia-ai/agents`; the caller-side package keeps
its name.

### Added

- `AgentService`, `AgentServiceOptions`, `PromptResponse`,
  `PromptHandler` — server-side helper for hosting a
  protocol-compliant agent (`prompt` + `status` endpoints, heartbeat
  loop, per-request keep-alive, terminator emission). Migrated from
  `@synadia-ai/agents`.
- `AgentServiceOptions.extraEndpoints` + `AgentServiceExtraEndpoint`
  — declarative way to register custom endpoints (e.g. a controller
  agent's `spawn` / `stop` / `list`) on the same `agents` micro
  service alongside `prompt` and `status`. Names are validated against
  collisions with the protocol-required endpoint names and within the
  array. Recommended over the `.service` getter for endpoints whose
  shape is known at construction time.
- `AgentService.service` getter — escape hatch returning the
  underlying `@nats-io/services` `Service`. Throws before `start()`.
  Use only for runtime-dynamic endpoint registration that
  `extraEndpoints` (locked at construction) can't express; bypasses
  the duplicate-name guard.
- `encodeChunk`, `splitResponseText`, and the
  `Chunk` / `ResponseChunk` / `StatusChunk` / `QueryChunk` types —
  chunk-encoder primitives for emitting response chunks. Migrated.
- `buildHeartbeatPayload`, `encodeHeartbeatPayload`,
  `BuildHeartbeatPayloadOptions` — heartbeat publisher helpers.
  Migrated. The `HeartbeatPayload` shape itself stays in
  `@synadia-ai/agents` (decoder side) and is imported from there.
- `DEFAULT_ATTACHMENTS_OK`, `DEFAULT_HEARTBEAT_INTERVAL_S`,
  `DEFAULT_KEEPALIVE_INTERVAL_S`, `DEFAULT_MAX_PAYLOAD` constants
  exposed on the package root for harnesses building on top of
  `AgentService`. Migrated.
- `ReferenceAgent` (and `ReferenceAgentOptions` /
  `ReferenceAgentPromptHandler`) — spec-compliant reference agent
  used as a counterparty in interop / integration tests. Available
  via the `@synadia-ai/agent-service/testing` subpath. Migrated.

# Changelog

All notable changes to `@synadia-ai/agent-service` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `AgentService` now maps handler-raised `ProtocolError`s to
  `Nats-Service-Error-Code: 400` responses while preserving the existing
  `500` mapping for ordinary handler failures. This lets agent adapters reject
  decoded-but-unsupported client input, such as attachments for an
  `attachments_ok=false` endpoint, without misreporting the request as a server
  failure.

## [0.5.2] - 2026-05-11

### Changed

- **Protocol rename.** Every reference to "NATS Agent Protocol" in
  this package's prose, package metadata, and source-file
  headers/docstrings now reads **Synadia Agent Protocol for NATS**.
  No API, wire shape, or protocol version (`0.3`) change.
- **Leading `status=ack` chunk is now emitted unconditionally (§6.4).**
  Spec §6.4 was sharpened to require that every prompt handler emit
  exactly one `{"type":"status","data":"ack"}` chunk as the **first**
  message on the reply subject, **before** any work that introduces
  observable latency
  ([synadia-agent-sdk-docs@b1c6972](https://github.com/synadia-ai/synadia-agent-sdk-docs/commit/b1c6972)).
  `AgentService.#dispatchPrompt` now publishes the ack after a
  successful envelope decode and before invoking the user-supplied
  handler — so every TS agent built on `AgentService` (the reference
  agent, `agents/open-agent`, any third-party harness) becomes
  spec-compliant on upgrade with no code change. The ack is emitted
  unconditionally; the `keepaliveIntervalS` option still controls only
  the periodic mid-stream cadence (which remains a valid wire shape
  for §6.6 inactivity-timer defense). Mirrors the parallel change in
  `synadia-ai-agent-service` 0.4.0.

  Wire-compatible: callers already accept arbitrary `status` chunks
  (`@synadia-ai/agents` decodes them as `{type:"status", status:"ack"}`
  events).

## [0.5.1] - 2026-05-04

### Changed

- **`AgentService` and `ReferenceAgent` now default `max_payload` to
  the broker's negotiated `nc.info.max_payload`** when the
  `maxPayload` constructor option is omitted, instead of the previous
  hardcoded `"1MB"` default. Callers that relied on an unconfigured
  agent advertising exactly `"1MB"` regardless of broker config will
  now see whatever the broker reports (e.g. `"8MB"` on NGS); on a
  default `nats-server` that's still `"1MB"`. The fallback to
  `DEFAULT_MAX_PAYLOAD = "1MB"` only kicks in when `nc.info` is
  missing — practically never, since `info` is populated as part of
  the connect handshake. Explicit `maxPayload` overrides retain the
  existing clamp-down semantics.

## [0.5.0] - 2026-05-04

No functional changes. Published in lockstep with `@synadia-ai/agents`
0.5.0 so consumers installing both packages stay version-aligned. The
`dependencies."@synadia-ai/agents"` pin tracks `^0.5.0`.

## [0.4.0] - 2026-05-01

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

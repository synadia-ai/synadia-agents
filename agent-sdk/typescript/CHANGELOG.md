# Changelog

All notable changes to `@synadia-ai/agent-service` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Request interceptors.** `AgentServiceOptions.interceptors`: each
  `RequestInterceptor`'s `aroundRequest(ctx, next)` runs around the prompt
  handler for every admitted request — after the envelope is decoded and
  the sender classified, before the §6.4 ack; the first listed is the
  outermost. `ctx` carries the decoded `envelope` (unknown top-level
  fields in `envelope.extras`), the classified `sender`, the `subject` and
  the request's `headers`. Throwing before `next()` refuses the request
  with no ack: a `RequestRejectedError(code, description)` answers its §9
  code (400–599), a `ProtocolError` `400`, anything else `500`. `next()`
  acks and runs the rest of the chain and the handler; an interceptor runs
  it inside its own context (`AsyncLocalStorage.run`), which the handler
  then sees. One that returns without calling `next()` answers `500`; a
  second call of `next()` rejects. A throw after `next()` resolved — the
  handler's reply already out in full — leaves that reply standing: no
  error frame, the normal terminator, and one error-level log line with a
  fixed message, never the error's details.
- **`heartbeatExtras`.** `AgentServiceOptions.heartbeatExtras` — a provider
  read when each heartbeat and each `status` reply is built, merged into
  its extras. A provider that throws, a §8.3 field name, or a value that
  does not serialize costs that beat its extras, never the beat, and is
  logged at `error`.
- **Signed heartbeats.** With `identity: { signer }` the service sets the
  `Agent-Sender` header of the sender-identity extension on every
  heartbeat it publishes — `sub` the heartbeat subject as published, `ts`
  the frame's own `ts`, a fresh nonce per beat, `sig` over subject · ts ·
  nonce · sha256 of the exact bytes published — with the signer that signs
  `id_sig`. No new payload field, no new signing format; a 0.3 subscriber
  ignores headers. Without a signer the service beats unsigned, as before;
  the status reply carries no header. A signer that fails mid-life costs
  the beat its signature, never the beat (logged at `error`); a signer
  slower than the interval never piles beats up — a tick that finds the
  previous beat still being signed is skipped and logged. `start()`
  resolves once the first beat is published; `stop()` lets a beat still
  being signed finish without publishing. `signHeartbeat` /
  `signHeartbeatHeader` and `HeartbeatSigner` are exported for hand-rolled
  publishers; the shared fixtures gain the `signed-heartbeat` vector.
- **Sender identity (the sender-identity extension).** `AgentService`
  classifies every `prompt` request before the §6.4 ack: a malformed
  `Agent-Sender` header → `400`; a failing signature, replayed nonce,
  stale `ts` or `sub` mismatch → `401` in every mode; an unsigned or
  header-less request on a `min_sender_trust: signed` endpoint → `401`
  (`signature required`); a sender the `acceptSender` hook refuses →
  `403` (verified) / `401` (claimed or absent); a throwing hook → `500`,
  never served. The classified sender reaches the handler as
  `PromptResponse.sender` (`VerifiedSender` with `id`, `ClaimedSender`
  without — never authorize on a claim — or `undefined`). `status` is
  classified and logged, never rejected. The extension is additive to
  protocol `0.3`.
  - Registration is opt-in: omitted `identity` performs no self lookup and
    emits no identity metadata; explicit `{}` requests unsigned
    `user_nkey` / `account`; a live-bound signer also adds `id_sig`
    (`AGENT-ID-V1` over the prompt subject). Identity keys override
    `extraMetadata` and are removed when identity is omitted.
    `min_sender_trust` is **always** emitted on the prompt endpoint
    (default `"any"`) — that key is what advertises the extension.
  - New `AgentServiceOptions`: `identity: { signer? }`, `minSenderTrust`,
    `replayWindowMs` (default 30 000; nonces expire at `ts + window`),
    `acceptSender`, `logger` (replaces the bare `console.warn`),
    `resolveTtlMs` (default 10 000) and `operatorAttested` (default
    `false`).
  - `PromptResponse.sender.resolve()` is bound: a verified sender resolves
    to the `AgentInfo` that registered its ID with a verifying `id_sig`
    (a `SenderResolver` on the host's connection, index cached for
    `resolveTtlMs`; `undefined` when no verified instance claims the key).
  - Operator-attested mode (spec Appendix A), `operatorAttested: true`:
    a verified header is cross-checked against the server's
    `Nats-Request-Info` stamp — disagreement on `acc` / `user`, or a stamp
    the server would not write, → `401`; agreement on `acc` →
    `sender.accountAttested === true`
    and `formatSender` renders `(verified)`. A deployment promise (closed
    endpoint) the SDK cannot verify; off by default, and `Nats-Request-Info`
    is never read otherwise. `AgentService.operatorAttested` getter.
  - `SenderGateOptions.operatorAttested` / `.resolver`,
    `SenderGate.operatorAttested`; `SenderGate.classify` now runs the
    caller package's `verifySender(msg, "live", …)`.
  - With a signer, `start()` requires the live connection's user and account
    to match and propagates every binding failure; it never starts with
    downgraded unsigned or absent identity metadata. Explicit unsigned
    registration remains best-effort.
  - `AgentService.identity` / `.minSenderTrust` getters.
  - `SenderGate` and `NonceCache` (`@synadia-ai/agent-service`) for
    hand-rolled services that want the same classification (the shared
    codec — `verifySenderHeader`, `SenderInfo`, `formatSender` — lives in
    `@synadia-ai/agents` and is not re-exported here).
  - `ReferenceAgent`: `identity`, `minSenderTrust`, `acceptSender`,
    `replayWindowMs`, `resolveTtlMs`, `operatorAttested`, `logger`; the prompt handler receives the
    classified sender as its second argument; the same registration
    metadata and classification as `AgentService`.

### Changed

- `extraMetadata` can no longer override the required registration keys.
  `AgentService` and `ReferenceAgent` now write `agent`, `owner` and
  `protocol_version` over `extraMetadata` (previously an extra entry
  replaced them), matching `session` and the identity keys, which already
  won. A harness can no longer advertise an agent or owner other than the
  subject it serves.
- `PromptResponse` takes an optional third constructor argument (the
  classified sender) and exposes it as `sender`.
- `ReferenceAgentPromptHandler` is now `(msg, sender) => …`; handlers
  that ignore the second argument are unaffected. The reference agent's
  `status` endpoint awaits classification before replying (like
  `AgentService`), so consecutive probes see each other's nonces in
  order.
- `maxPayload` clamping warns through the configured `logger` instead of
  `console.warn`.
- `AgentService.start()` and `ReferenceAgent.start()` now flush the
  connection before returning, so "started" means the endpoint
  subscriptions are registered at the server — a caller on another
  connection that discovers or prompts right away no longer races them
  (no responders).
- Replay rejection details omit raw nonces, and `acceptSender` hook failures
  log only a fixed safe marker rather than application-controlled exception
  names or messages.
- **BREAKING (pre-1.0):** `AgentService` and `ReferenceAgent` no longer expose
  the unusable `accountTokenPosition` option: their fixed five-token
  subscriptions cannot receive the inserted six-token subject. Applications
  that need an account token in a remapped subject must use a hand-rolled
  wildcard service with `SenderGate({ accountTokenPosition: … })` or call
  `verifySenderHeader(…, { accountTokenPosition: … })` directly.
- Unexpected handler, status, and classification failures use generic wire
  descriptions and fixed log markers; application-controlled exception names,
  messages, and stacks are never emitted by the SDK.

### Changed (pre-identity)

- **Examples: identity env vars moved to the `SYNADIA_*` scheme.** The
  numbered examples now resolve `owner`/`name` through the per-agent >
  fleet-wide > legacy chain (`SYNADIA_<AGENT>_OWNER` > `SYNADIA_OWNER` >
  `NATS_AGENT_OWNER`, same for `_NAME`), matching the env naming
  convention being adopted across `agents/*`. The legacy
  `NATS_AGENT_OWNER` / `NATS_AGENT_NAME` vars keep working as
  lowest-priority aliases; no package API change.
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

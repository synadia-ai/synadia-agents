# Changelog

All notable changes to `@synadia/agents` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - protocol `0.2.0-draft`

Tracks the rename of the protocol's service filter (spec §3.1) and the new
queue-group requirement on the `prompt` endpoint (§3.3). **Not wire-compatible
with 0.1**: agents and callers must be upgraded together.

### Changed

- **Service name**: `"Synadia Agents"` / `"SynadiaAgents"` → `"agents"`.
  `SERVICE_NAME_CANONICAL` and `SERVICE_NAME_COMPACT` are removed;
  `SERVICE_NAME = "agents"` is the single source of truth.
  `isAgentServiceName` now accepts only `"agents"`.
- **Protocol version**: `SDK_PROTOCOL_VERSION` bumped to `{ major: 0, minor: 2 }`;
  the reference agent advertises `metadata.protocol_version = "0.2"`.

### Added

- **`PROMPT_QUEUE_GROUP` constant** (`"agents"`) exported from the package
  root. The `ReferenceAgent` now registers its `prompt` endpoint with
  `queue: PROMPT_QUEUE_GROUP` per §3.3.
- **`EndpointInfo.queueGroup`**: carries the per-endpoint queue group from
  `$SRV.INFO`. Callers can verify the prompt endpoint advertises `"agents"`.

### Added (carried over from the unreleased 0.1 changes)

- **NATS CLI context support** per spec §10.2. `connect({ context: "prod" })`
  loads `~/.config/nats/context/prod.json`, resolves servers + auth, and
  opens the connection. `context: "current"` or `context: true` uses the
  selection set by `nats context select` (with `$NATS_CONTEXT` as an
  override). Explicit `servers` / `nats` fields still win over
  context-derived values.
- **`loadNatsContext(selector, env?)`** exposed as a standalone helper for
  power users who want to inspect a context before passing it to `connect()`.
- **`NatsContextError` hierarchy**: `NatsContextNotFoundError`,
  `NatsContextNotSelectedError`, `NatsContextInvalidError`.
- **`TODO.md`** tracking the deferred context fields (`nkey`, TLS `cert`/`key`/`ca`,
  `nsc`), stretch agent-hosting surface, browser build, and upstream spec questions.

### Migration

- Upgrade every agent in your deployment to a 0.2-speaking build before
  upgrading the SDK - clean cutover, no dual-name accept.
- Any custom agent registration needs `queue: "agents"` added to its
  `addEndpoint("prompt", ...)` options.

### Deferred (see `TODO.md`)

- `nkey` auth, TLS cert/key/ca files, `nsc`-based credential derivation.
  Common cases (`url`, `creds`, `token`, `user`/`password`, `user_jwt`,
  `inbox_prefix`) ship in `0.2`.

## [0.1.0] - initial pre-release

Implements the client surface of the NATS Agent Protocol `0.1.0-draft`.

### Added

- **`connect()` / `attach()`** factories for opening or wrapping a NATS connection (§3.2 service registration is agent-side - callers only discover).
- **`Client.discover({timeoutMs, filter})`** with auto subscribe-before-PING per §8.5 and client-side identity filtering (`{agent, owner, name, session, protocolVersion}`).
- **`Client.bind(DiscoveredAgent)`** returns a `RemoteAgent` handle.
- **`RemoteAgent.prompt(text, {attachments, signal, inactivityTimeoutMs})`** - JSON envelope per §5.1; attachments base64-encoded per RFC 4648 §4.
- **Pre-publish local validation per §5.4:** `PromptEmptyError`, `AttachmentsNotSupportedError`, `PayloadTooLargeError` - all rejected before any wire traffic.
- **`PromptStream`** implementing `AsyncIterable<StreamMessage>` with `.cancel()`, `.replySubject`, and `AbortSignal` support.
- **Chunk decoder** for `response` (bare-string + object forms), `status`, `query` chunks per §6.2–§7. Unknown `type` values silently dropped per §6.6.
- **Synthetic `{type: "status", status: "done"}`** emitted as the final event on terminator (§6.4 permits).
- **Inactivity timeout** (§6.6) defaulting to 60 s; resets on every chunk including `status: ack`.
- **`ServiceError`** carrying `code`, `description`, and parsed JSON body (§9.1).
- **Mid-stream query (§7)** via `QueryEvent.reply(string | RequestEnvelope)`; second call throws `QueryAlreadyRepliedError`.
- **Heartbeat tracking (§8)** keyed on `instance_id` (not subject) - multi-instance safe. Narrow wildcard via `heartbeatScope: {agent, owner}`.
- **`Client.ping(instanceId)`** for on-demand reachability (§8.4).
- **`Client.close()`** aborts all in-flight streams via shared AbortController; closes connection iff owned.
- **Subpath exports:** `@synadia/agents/errors`, `@synadia/agents/testing` (spec-compliant `ReferenceAgent` + harness).
- **Runtime-agnostic pure core** - envelope, validation, chunk-decoder, terminator, bytes, version, subjects, endpoint-info, heartbeat-payload - enforced by ESLint.
- **5 runnable examples** under `examples/`; spec-compliance docs under `docs/protocol-mapping.md`.

### Known upstream questions

- `max_payload` base (1024 vs 1000) - spec silent. SDK uses 1024.
- Size-unit case sensitivity - spec silent. SDK parses case-insensitive.

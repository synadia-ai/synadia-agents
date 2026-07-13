# Changelog

All notable changes to `@synadia-ai/agents` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** this SDK was developed under the placeholder name
> `@synadia/agents` but never actually published to npm under that name.
> The `[0.2.0-dev]` and `[0.1.0-dev]` sections below document the API as
> it evolved prior to the rebrand; they are retained as design history,
> not actual npm releases. `[0.1.0]` is the first real release under
> `@synadia-ai/agents`.

## [Unreleased]

### Fixed

- **`decodeEnvelope` now follows the §5.3 discrimination algorithm
  exactly**, closing two wire-compatibility gaps with the spec and the
  Python SDK:
  - A **zero-byte request payload** is now rejected with a
    `ProtocolError` (→ agent `400`). Previously it was silently accepted
    as `{ prompt: "" }`. Spec §5.3: "A zero-byte request payload is
    invalid and MUST be rejected with status `400`."
  - A payload whose **first non-whitespace byte is `{` but which is not
    well-formed JSON** (e.g. `{not json`) is now rejected as a malformed
    envelope, instead of being mis-classified as a plain-text prompt
    literally equal to the broken JSON. Discrimination now keys off the
    leading `{` (matching the Python SDK's `looks_like_json`) rather than
    "try `JSON.parse`, fall back to plain text on any failure".

  Plain-text shorthand for payloads that don't lead with `{` (including
  bare numbers, `[`, or quotes) is unchanged, as is rejection of
  missing / non-string / empty `prompt` and invalid attachments. The pi
  spec-compliance smoke (`agents/pi/test/smoke.mjs`) caught both gaps.

- **`loadContextOptions` now loads the TLS triple's file contents**
  (the `cert` / `key` / `ca` context fields) into the standard
  `tls.cert` / `tls.key` / `tls.ca` connection options, instead of
  passing paths through the Node-only `certFile` / `keyFile` / `caFile`
  helper fields. Fixes client mTLS on runtimes whose transports don't
  expand the helper fields (e.g. Bun) — a context created with
  `nats context add --tlscert/--tlskey/--tlsca` now works everywhere
  the standard options do. See
  [#164](https://github.com/synadia-ai/synadia-agents/pull/164).

  Behavior notes:

  - Missing or unreadable TLS files now throw a `NatsContextError`
    (with `cause`) from `loadContextOptions()` instead of failing
    later inside `connect()`. This matches how `creds` / `nkey` files
    are already read eagerly at context-load time, and it turns the
    "stuck reconnecting on a bad cert path" failure mode (see the
    0.5.2 behavior notes) into a fast, actionable error.
  - TLS material is snapshotted at load time. Long-lived processes no
    longer pick up rotated cert files on reconnect the way the
    transport's per-attempt `certFile` reads did; call
    `loadContextOptions()` again (and reconnect) to refresh.

## [0.5.2] - 2026-05-26

### Added

- `withAgentReconnectDefaults(opts?)` and `AGENT_RECONNECT_DEFAULTS` —
  opinionated reconnect defaults for agent runtimes:
  `maxReconnectAttempts: -1`, `reconnectTimeWait: 2000`,
  `reconnectJitter: 200`, `waitOnFirstConnect: true`. Pure transform
  that fills in only the fields the caller left undefined, so explicit
  `0` / `false` overrides survive untouched. `opts` defaults to `{}`
  for parity with `connect()`'s no-argument form. See
  [#121](https://github.com/synadia-ai/synadia-agents/issues/121).

### Behavior notes

- The new helper is opt-in. Existing callers that go straight to
  `connect()` without wrapping their options keep the upstream
  nats.js defaults (~20s reconnect budget, then `close`).
- `waitOnFirstConnect: true` means `connect()` retries through a
  server that is unreachable at startup. Misconfigured URLs or TLS
  cert paths now manifest as a stuck "reconnecting…" UI rather than
  an immediate throw — desirable for agent runtimes, surprising for
  short-lived clients. Callers who want the throw-fast behavior
  should pass `waitOnFirstConnect: false` explicitly (the helper
  preserves it).

## [0.5.1] - 2026-05-11

### Changed

- **Protocol rename.** Every reference to "NATS Agent Protocol" in
  this package's prose, package metadata, and source-file
  headers/docstrings now reads **Synadia Agent Protocol for NATS**.
  No API, wire shape, or protocol version (`0.3`) change.

## [0.5.0] - 2026-05-04

> Breaking: removes the `PromptStream.replySubject` getter from the
> 0.4.0 public surface. See "Removed" below.

### Changed

- `PromptStream` now drives the response with `nc.requestMany` using
  the `sentinel` strategy (the wire terminator's empty-body shape
  doubles as the sentinel). Replies route through the connection's
  shared mux inbox instead of a fresh per-stream subscription, removing
  the explicit `subscribe → flush → publish` dance and per-call
  `_INBOX.agents.>` subject. Behavior over the wire is unchanged.

### Added

- `PromptOptions.maxWaitMs` — absolute ceiling for a single prompt
  response, passed through to `requestMany`'s `maxWait`. Distinct from
  `inactivityTimeoutMs` (which still enforces §6.6 idle-gap
  detection). Default exported as `DEFAULT_PROMPT_MAX_WAIT_MS`
  (10 minutes).
- `StreamMaxWaitExceededError` — thrown when a prompt stream runs past
  its absolute `maxWaitMs` ceiling without seeing the wire terminator,
  even if chunks were still arriving under the inactivity gap.

### Removed

- `PromptStream.replySubject` getter. With the requestMany / mux move
  the inbox is shared across all in-flight requests on the connection,
  so the per-stream value lost meaning. The getter was documented as a
  debugging aid and is not used by any tests or examples in-tree.

## [0.4.0] - 2026-04-30

> **Note:** `0.3.0` was tagged in code (verb-first wire bump + max_payload
> work) but never published to npm — the changeset moved through `file:`
> dev-cycle PRs only. `0.4.0` bundles the 0.3.0 wire changes together
> with the agent + example SDK adoption work and the new public surface
> listed below.

### Added

- `HeartbeatTracker` is now exported from the package root. Existing
  internal usage by `Agents.onHeartbeat` is unchanged; consumers that
  want the heartbeat-wildcard primitive directly (e.g.
  `examples/agent-web-ui/server/bridge.ts`, agent harnesses adopting
  the SDK) can now import it without reaching into the source tree.
- `formatHumanBytes`, `parseHumanBytes`, and `InvalidSizeError` are
  exported from the package root. They were added to `./bytes.js` for
  the broker-derived `max_payload` clamp work but kept internal;
  exporting them lets the agent harnesses replace identical
  `formatMaxPayloadString` copies with one tested SDK helper.
- `Agents.lookupInstance(instanceId, opts?)` — targeted
  `$SRV.INFO.agents.<id>` lookup that materialises a single `Agent`
  for an already-known instance id without running a full discovery
  scan. Returns `null` on timeout, no-responders, or malformed
  metadata. The returned `Agent` shares the parent client's
  connection and close signal so in-flight streams are cancelled
  alongside everything else when the client closes.
- `splitResponseText(text, maxPayloadBytes, opts?)` — UTF-8-safe
  chunker for long response payloads. Iterates by code-point so
  multi-byte UTF-8 sequences and UTF-16 surrogate pairs are never
  split mid-character. Replaces three near-identical
  `splitTextForChunks` / `publishResponseText` helpers carried by
  the `agents/{claude-code,openclaw,pi}` harnesses.
- `AgentSubject` + `AgentService` accept an optional `subjectToken`
  override. When set, the wire token in the subject's 3rd position is
  the override; `metadata.agent` (in `$SRV.INFO`) keeps the canonical,
  longer identifier. Default behaviour unchanged — both come from
  `agent`. Lets harnesses like `claude-code` (`agent="claude-code"`,
  `subjectToken="cc"`) and `openclaw` (`agent="openclaw"`,
  `subjectToken="oc"`) adopt the SDK's `AgentSubject` / `AgentService`
  while preserving their established subject layouts.

### Changed (breaking — host-side surface moved out)

- `AgentService`, `PromptResponse`, `PromptHandler`, `AgentServiceOptions`,
  `ReferenceAgent`, `encodeChunk`, `splitResponseText`, the
  `Chunk` / `ResponseChunk` / `StatusChunk` / `QueryChunk` types,
  `buildHeartbeatPayload`, `encodeHeartbeatPayload`,
  `BuildHeartbeatPayloadOptions`, and the `DEFAULT_ATTACHMENTS_OK` /
  `DEFAULT_HEARTBEAT_INTERVAL_S` / `DEFAULT_KEEPALIVE_INTERVAL_S` /
  `DEFAULT_MAX_PAYLOAD` constants moved to a new sibling package
  `@synadia-ai/agent-service`. Caller-side imports
  (`Agents`, `Agent`, `AgentSubject`, `decodeEnvelope`,
  `decodeHeartbeatPayload`, the error hierarchy, etc.) are unchanged.
- The `./testing` subpath (`@synadia-ai/agents/testing`,
  `ReferenceAgent`) moved to `@synadia-ai/agent-service/testing`.
- Hosting an agent now requires installing both
  `@synadia-ai/agents` (caller-side primitives) **and**
  `@synadia-ai/agent-service` (server-side helpers). Caller-only
  consumers (e.g. `examples/agent-web-ui`) need no code changes.
- `decodeChunk` plus the `DecodedChunk` / `DecodedQuery` /
  `DecodedResponse` / `DecodedStatus` types are now exported from the
  package root. Previously only `DecodedAttachment` was surfaced; the
  full decoder side is now part of the documented caller API and
  consumed by `@synadia-ai/agent-service`'s round-trip tests.
- `newInbox` is exported with `@internal` JSDoc — re-used by
  `@synadia-ai/agent-service` so caller and host share the same
  `_INBOX.agents.>` reply-subject prefix.

### Changed

- `loadContextOptions` now honours the full set of fields written by
  `nats context add`. `nkey` (file path) is read and passed through
  `nkeyAuthenticator`; an inline `user_seed` paired with `user_jwt`
  flows through `jwtAuthenticator(jwt, seed)` so nonce signing works;
  the TLS triple `cert` / `key` / `ca` plus boolean `tls_first`
  populate `opts.tls = { certFile, keyFile, caFile, handshakeFirst }`.
  Auth precedence is now: `creds` > `nkey` > `user_jwt` (+ optional
  `user_seed`) > inline `user`/`password` > inline `token`. Centralises
  what `agents/pi`'s and `agents/claude-code`'s `contextToConnectOpts`
  helpers have been doing in parallel.
- Caller-side §5.4 validation now considers **both** the agent's
  advertised `max_payload` _and_ the caller's own
  `nc.info.max_payload` (the broker holding the caller's
  connection). The effective cap is the smaller of the two — in
  multi-cluster / per-account deployments the caller's broker may
  reject an oversized publish with `MAX_PAYLOAD_VIOLATION` before it
  ever reaches the agent. `assertWithinMaxPayload(size, endpoint)`
  gains an optional third `connectionMaxPayload?: number` parameter;
  `Agent.prompt` passes `this.#nc.info?.max_payload` so callers fail
  fast when their own connection is the binding constraint. Mirrors
  the same change on the Python side.
- `AgentService(maxPayload)` and `ReferenceAgent(maxPayload)` are now
  clamped down to the connected server's negotiated limit
  (`nc.info.max_payload`, populated from the NATS `INFO` block) at
  `start()`. If the override is larger than the server allows, the
  SDK `console.warn`s and advertises the server's value (formatted via
  the new `formatHumanBytes` helper exported from `./bytes.js`).
  Smaller overrides are still honored (use case: shed expensive
  prompts before they reach the handler). When the server didn't
  report a value (e.g. an INFO block without `max_payload`), the
  override stands as configured. Mirrors the same clamp added to the
  Python `AgentService`. Rationale: advertising larger than the
  broker accepts only sets up callers for `MAX_PAYLOAD_VIOLATION`
  rejections at publish time — the broker enforces the real cap, so
  the metadata should match.

### Changed (wire-breaking)

- **Wire moves to verb-first subjects (protocol v0.3).** The agent
  subject hierarchy gains a verb token directly after the root so each
  endpoint owns its own positional slot:

  | endpoint  | v0.2 wire                      | v0.3 wire (this release)                                                                   |
  | --------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
  | prompt    | `agents.{a}.{o}.{n}`           | `agents.prompt.{a}.{o}.{n}`                                                                |
  | heartbeat | `agents.{a}.{o}.{n}.heartbeat` | `agents.hb.{a}.{o}.{n}` (verb abbreviated; heartbeats dominate per-account subject volume) |
  | status    | —                              | `agents.status.{a}.{o}.{n}` (new)                                                          |

  No back-compat shim — 0.x permits breaking changes per protocol §11.2,
  and silent talk-past between v0.2 and v0.3 callers is worse than a
  hard refusal at discovery time.

- **`metadata.protocol_version` `"0.2"` → `"0.3"`.** Old v0.2 callers
  advertise `"0.2"` and therefore won't match a v0.3 agent's subjects;
  metadata-driven discovery filters make the mismatch a hard refusal.
- **Heartbeat tracker subscribes to `agents.hb.*.*.*`** (the exported
  `HEARTBEAT_SUBJECT` constant). The tracker still keys on
  `payload.instance_id` per §8.3.
- **`AgentInfo.name` now derives from the 5th token** of the prompt
  endpoint subject (was the 4th under v0.2). `AgentInfo.session` continues
  to surface `metadata.session` when the agent advertises a §5.6
  conversation label — the two fields stay distinct: the name is the
  per-instance subject identity, the session is an envelope-level label.

### Added

- **`AgentService` (new server-side helper).** Mirrors the Python SDK's
  `AgentService` — registers as the `agents` micro service with
  protocol-required metadata, adds `prompt` + `status` endpoints with
  queue group `"agents"`, runs the §8.1 heartbeat publisher loop, runs a
  per-request keep-alive task while the prompt handler is in flight, and
  emits the §6.5 stream terminator on every completion path. Replaces
  the boilerplate every agent harness used to roll by hand. Constructor:
  `new AgentService({nc, agent, owner, name, ...})`; register a handler
  via `service.onPrompt((envelope, response) => ...)`; `start()` /
  `stop()`. Comes with `PromptResponse` (server-side stream handle) for
  emitting chunks (`response.send(...)`) and mid-stream queries
  (`response.ask(prompt, {timeoutMs})`).
- **`AgentSubject`** — verb-first subject builder. `AgentSubject.new(agent,
owner, name)` validates the three identifying tokens and exposes
  `.prompt` / `.heartbeat` / `.status` getters that build the v0.3
  subjects. Single source of truth across SDK, agent harnesses, and
  examples — the verb-first wire shape lives in exactly one place.
- **Verb constants** (`VERB_PROMPT="prompt"`, `VERB_HEARTBEAT="hb"`,
  `VERB_STATUS="status"`, `VERB_ATTACHMENTS="attachments"`,
  `RESERVED_VERBS`, `SUBJECT_ROOT="agents"`) and helpers
  (`parseAgentSubject(subject, {verb})`, `isHeartbeatSubject(subject)`).
- **`status` request/response endpoint (§8.7 (v0.3)).** Every
  `AgentService` (and `ReferenceAgent`) registers an additional NATS
  micro endpoint named `status` on `agents.status.{a}.{o}.{n}` (queue
  group `"agents"`). Replies with the same JSON payload shape as a
  heartbeat (`HeartbeatPayload`, §8.3) constructed fresh on each
  request. Future PRs can extend the response with richer agent
  metadata in one place — both the heartbeat publisher and the status
  handler share the new `buildHeartbeatPayload(...)` helper. Exported
  sibling constants: `STATUS_ENDPOINT_NAME`, `STATUS_QUEUE_GROUP`.
- **`buildHeartbeatPayload(subject, intervalS, instanceId, options?)`** —
  pure helper that returns a `HeartbeatPayload` with the §8.3 fields
  populated. Optional `session` and `extras` for §5.6 / §6.6 forward-
  compat fields.
- **`encodeHeartbeatPayload(payload)`** — encode a `HeartbeatPayload`
  to the wire-shape JSON bytes (snake_case keys per §8.3). `extras` are
  splatted alongside the known fields so `decode → build → encode`
  round-trips preserve forward-compat fields.
- **Agent-side envelope decoder** (`decodeEnvelope`) — parses an
  inbound `Uint8Array` into a validated `RequestEnvelope`, performs
  §5.2 strict base64 decoding (rejects URL-safe / unpadded /
  whitespace), enforces filename safety (rejects path separators, NUL,
  `.`/`..`), and falls back to the §5.3 plain-text shorthand on JSON
  parse failure. Throws `ProtocolError` for malformed input — agent
  services translate this into a `Nats-Service-Error-Code: 400`
  response. Replaces the hand-rolled decoder duplicated across
  `agents/pi/`, `agents/claude-code/`, `agents/openclaw/`.
- **Strict base64 helper** (`decodeStrictBase64`) — RFC 4648 §4
  decoder that rejects non-strict input. Sibling of the existing
  tolerant `decodeBase64`.
- **Chunk encoder module** (`encodeChunk`, types `Chunk`, `ResponseChunk`,
  `StatusChunk`, `QueryChunk`) — pure encoder mirroring the existing
  `chunk-decoder.ts`. Used by `AgentService` to push response / status /
  query chunks back to the caller.
- **`parseNatsUrl(url)`** — sibling of `loadContextOptions` that converts
  a NATS URL into `NodeConnectionOptions`, extracting credentials from
  `userinfo` if present:
  - `nats://TOKEN@host:port` → `{ servers, token }`
  - `nats://USER:PASS@host:port` → `{ servers, user, pass }`
  - `nats://a:4222,nats://b:4222` (multi-server) supported; mixed
    credentials across entries throw `NatsContextError`.

  Bridges a UX gap: the `nats` CLI parses userinfo from URLs, but
  `@nats-io/transport-node` does not — meaning every example in this
  repo that accepted `--url URL` silently dropped the token when given
  the URL form, even though the same URL worked with `nats` CLI /
  `nats context save`. Every example's `--url` path now goes through
  `parseNatsUrl` (`agent-web-ui`, `pi-headless`, `claude-code-headless`,
  `dspy`).

### Changed

- Reply-inbox prefix for prompt streams is now fixed at `_INBOX.agents`
  (was `_INBOX`). The prefix is held constant across language SDKs so a
  single NATS permission (`_INBOX.agents.>`) covers caller-side reply
  traffic regardless of language. Not user-overridable.
- `Liveness.isOnline` boundary tightened from `<` (exclusive) to `<=`
  (inclusive) — a heartbeat that arrived exactly `slack * interval_s`
  seconds ago is now considered online, matching the docstring's "within"
  wording and the Python SDK's behaviour.
- `ReferenceAgent` (testing) rebased on `AgentSubject` and the new helper
  module. Now also registers a `status` endpoint, so SDK integration
  tests that exercise it cover the new endpoint automatically. The
  `subjectAgentToken` option is gone — agents declare a single
  `agent` token used in both metadata and the subject.
- `DEFAULT_DISCOVER_STALL_MS` bumped from `200` → `750` so the default
  `discover()` (stall strategy) survives a transcontinental NATS
  round-trip — e.g. demo.nats.io reports ~315 ms RTT from a non-US
  client, which previously caused `discover()` to return an empty
  list before the first reply arrived. Snappy on LAN brokers stays
  true at 750 ms (still well under one perceptible UI tick); callers
  wanting a tighter window can pass `timeoutMs` (timer strategy) or
  the lower-level `stallMs`. Fixes [#31].

### Anticipated companion work (this release)

This SDK release coordinates with refactors of every agent harness and
example in the monorepo to v0.3:

- **`agents/pi/`, `agents/claude-code/`, `agents/openclaw/`** adopt the
  new `AgentService`, dropping their hand-rolled service registration,
  heartbeat loops, status endpoint scaffolding, and envelope decoders.
- **`examples/pi-headless/`, `examples/claude-code-headless/`,
  `examples/dspy/`, `examples/agent-web-ui/`** pick up the new wire
  shape transparently — `pi-headless` and `claude-code-headless` switch
  their managed-session implementations from `ReferenceAgent` to
  `AgentService`; `dspy` continues on `ReferenceAgent` (test-fixture
  pattern stays appropriate for the demo agent).
- **READMEs + CLAUDE.md** across the monorepo update their subject
  layouts (root, `agents/README.md`, `examples/README.md`, every
  per-agent and per-example README).
- **Spec docs** at `synadia-ai/synadia-agent-sdk-docs` get the v0.3
  verb-first subject hierarchy + `status` endpoint section in a
  follow-up PR.

## [0.1.1] - 2026-04-25

### Added

- **`loadContextOptions(selector)`** — resolves a `nats` CLI context by
  name (or `"current"`) into `NodeConnectionOptions` ready to pass to
  `connect()`. Re-introduces the lookup logic that was dropped in `[0.1.0]`,
  this time as a thin standalone helper rather than a `connect({ context })`
  factory: callers still own the `NatsConnection`. Supports `url`, `creds`,
  `user_jwt`, `user`/`password`/`token`, and `inbox_prefix`; `nkey` and TLS
  cert/key/ca remain deferred. Strict name validation rejects path
  separators, null bytes, and bare `..`.
- **`NatsContextError`** exported as the single error class for context
  resolution failures.

## [0.1.0] - 2026-04-24

**First release under the `@synadia-ai/agents` npm scope.** The API
shipped at 0.1.0 matches what was previously staged under `[Unreleased]`
during pre-rebrand development — the `new Agents({ nc })` entry point,
directly-callable `Agent[]` from `discover()`, and the `stall` default.
Breakage and removals below are expressed relative to `[0.2.0-dev]`
(the last pre-rebrand design state); as a first real release under the
new scope, this _is_ the shipping API.

### Changed (breaking) vs `[0.2.0-dev]`

- **Single entry point: `new Agents({ nc })`.** The SDK no longer opens
  NATS connections — callers build a `NatsConnection` via
  `@nats-io/transport-node` (`connect`) or `@nats-io/nats-core` (`wsconnect`)
  and hand it to `new Agents({ nc })`. This aligns with every other
  `@nats-io/*` library (`jetstream(nc)`, `new Svcm(nc)`, `Kvm(nc)`…) and
  lets callers share one `NatsConnection` across JetStream, KV, services,
  and agents.
- `Client` → `Agents`. `ClientOptions` → `AgentsOptions`.
- `agents.close()` no longer closes the underlying `NatsConnection`; the
  caller owns it and closes it themselves.
- **`agents.discover()` returns a live `Agent[]`.** Each `Agent` is
  directly callable — no `bind()` step. `DiscoveredAgent` + `RemoteAgent`
  are merged into a single `Agent` class that carries both the parsed
  `$SRV.INFO` metadata (flat fields: `instanceId`, `agent`, `owner`,
  `name`, `session`, …) and the `.prompt()` method.
- Group / filter agents with the built-in `Array` / `Map.groupBy` API —
  no SDK-specific helpers. Identity is metadata-driven (`agent`, `owner`,
  `name`, `session?`, `instanceId`); prompt subjects are agent-chosen per
  spec §3.1 and should not be used as stable identity keys.
- **`discover()` default now uses the `stall` strategy** — returns 200ms
  after the most recent reply (safety cap 2000ms), so interactive paths
  feel snappy instead of always blocking the full window. Passing
  `timeoutMs` switches back to the `timer` strategy for deterministic
  scans. New constants exported: `DEFAULT_DISCOVER_STALL_MS`,
  `DEFAULT_DISCOVER_MAX_WAIT_MS`.

### Removed

- **`connect()` / `attach()` / `ConnectOptions` / `AttachOptions`**.
  Replaced by `new Agents({ nc })`.
- **`Agents.bind()`** — `discover()` now returns live handles directly.
  Callers with a config-driven set of target agents discover once and
  match by metadata (see README).
- **`RemoteAgent` / `DiscoveredAgent`** — merged into `Agent`.
- **`buildDiscoveredAgent`** — renamed to `buildAgentInfo`.
- **`ClientOptions.name`** — the NATS connection already carries its own
  `name` for server-side identification; the SDK-side label was unused.
- **`ClientOptions.heartbeatScope` / `HeartbeatScope`** — the heartbeat
  wildcard is now fixed at `agents.*.*.*.heartbeat`. Narrow discovery
  results with `agents.discover({ filter })` instead.
- **NATS CLI context support** (already removed earlier this release):
  `connect({ context })`, `loadNatsContext()`, and `NatsContextError`.

### Migration

```ts
// Before
import { connect } from "@synadia-ai/agents";
const client = await connect({ name: "my-app", servers: "nats://localhost:4222" });
const found = await client.discover();
const remote = client.bind(found[0]!);
await remote.prompt("hi");

// After
import { connect as natsConnect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const nc = await natsConnect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });
const found = await agents.discover(); // Agent[] — directly callable
await found[0]!.prompt("hi");
// ...
await agents.close();
await nc.close(); // caller owns the connection
```

**Config-driven binding** (common pattern for apps with an array of target agents):

```ts
const configured = [
  { agent: "ccc", owner: "alice", name: "worker-1" },
  { agent: "pi", owner: "bob", name: "oracle" },
];
const found = await agents.discover({ timeoutMs: 2_000 });
const byKey = new Map(found.map((a) => [`${a.agent}/${a.owner}/${a.name}`, a]));
const bound = configured
  .map((c) => byKey.get(`${c.agent}/${c.owner}/${c.name}`))
  .filter((a): a is Agent => a !== undefined);
```

## [0.2.0-dev] - protocol `0.2.0-draft` (pre-rebrand design history)

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

## [0.1.0-dev] - initial pre-release (pre-rebrand design history)

Implements the client surface of the Synadia Agent Protocol for NATS `0.1.0-draft`.

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
- **Subpath exports:** `@synadia-ai/agents/errors`, `@synadia-ai/agents/testing` (spec-compliant `ReferenceAgent` + harness).
- **Runtime-agnostic pure core** - envelope, validation, chunk-decoder, terminator, bytes, version, subjects, endpoint-info, heartbeat-payload - enforced by ESLint.
- **5 runnable examples** under `examples/`; spec-compliance docs under `docs/protocol-mapping.md`.

### Known upstream questions

- `max_payload` base (1024 vs 1000) - spec silent. SDK uses 1024.
- Size-unit case sensitivity - spec silent. SDK parses case-insensitive.

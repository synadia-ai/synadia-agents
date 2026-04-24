# Changelog

All notable changes to `@synadia-ai/agents` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** this SDK was developed under the placeholder name
> `@synadia/agents` but never actually published to npm under that name.
> The `[0.2.0-dev]` and `[0.1.0-dev]` sections below document the API as
> it evolved prior to the rebrand; they are retained as design history,
> not actual npm releases. `[0.1.0]` is the first real release under
> `@synadia-ai/agents`.

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
- **Subpath exports:** `@synadia-ai/agents/errors`, `@synadia-ai/agents/testing` (spec-compliant `ReferenceAgent` + harness).
- **Runtime-agnostic pure core** - envelope, validation, chunk-decoder, terminator, bytes, version, subjects, endpoint-info, heartbeat-payload - enforced by ESLint.
- **5 runnable examples** under `examples/`; spec-compliance docs under `docs/protocol-mapping.md`.

### Known upstream questions

- `max_payload` base (1024 vs 1000) - spec silent. SDK uses 1024.
- Size-unit case sensitivity - spec silent. SDK parses case-insensitive.

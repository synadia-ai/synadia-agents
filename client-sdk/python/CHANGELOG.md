# Changelog

All notable changes to `synadia-ai-agents` are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
the 0.x line is explicitly unstable per protocol spec §11.2.

## [Unreleased]

### Changed

- Reply-inbox prefix for prompt streams, mid-stream queries, and
  internal `$SRV.INFO` discovery is now fixed at `_INBOX.agents` (was
  the connection's default `_INBOX`). The prefix is held constant
  across language SDKs so a single NATS permission
  (`_INBOX.agents.>`) covers caller-side reply traffic regardless of
  language. The connection's `inbox_prefix` is no longer consulted for
  agents-SDK reply subjects; not user-overridable.
- `DEFAULT_DISCOVER_STALL_S` bumped from `0.2` → `0.75` so the default
  `discover()` (stall strategy) survives a transcontinental NATS
  round-trip — e.g. demo.nats.io reports ~315 ms RTT from a non-US
  client, which previously caused `discover()` to return an empty
  list before the first reply arrived. Snappy on LAN brokers stays
  true at 750 ms (still well under one perceptible UI tick); callers
  wanting a tighter window can pass `stall=` to `agents.discover()` /
  `discover_agents()`. Fixes [#31]. Mirrors the same constant change
  in the TypeScript SDK so cross-SDK defaults stay aligned.

### Changed (breaking, public API)

- **Token 5 of every agent subject is the *session name*; no more
  separate "instance name" + envelope/metadata `session` field.** The
  SDK collapses the previous `name` + `session` pair into one
  positional concept: `agents.{verb}.{agent}.{owner}.{session_name}`.
  A worker that wants to host N sessions registers N services (one
  per session-named subject); the §3.3 queue group `"agents"` keeps
  load-balancing across instances of the same logical session. The
  envelope-level multiplexing pattern (Hermes-style: one subject,
  many envelope.session labels) is dropped.
- **Renames** (every site mirrors the same identifier):
  - `AgentSubject.name` → `AgentSubject.session_name`
  - `AgentSubject.new(..., name=...)` → `AgentSubject.new(..., session_name=...)`
  - `AgentService(..., name=..., session=...)` → `AgentService(..., session_name=...)`
  - `AgentInfo.name` → `AgentInfo.session_name`
  - `Agent.name` → `Agent.session_name`
  - `DiscoverFilter(name=..., session=...)` → `DiscoverFilter(session_name=...)`
- **Removals**:
  - `metadata.session` (§3.2) — agents no longer advertise it.
  - `HeartbeatPayload.session` (§8.3) — the publishing subject IS the
    session.
  - `Envelope.session` (§5.1) — the request subject IS the session.
    A stray inbound `session` from a non-compliant peer rides the
    §5.6 `extra="allow"` unknown-field bag instead of surfacing as a
    first-class field.
  - `AgentService(session=...)` and `Agent.prompt(session=...)`
    kwargs — both lost their feed once the metadata/envelope/payload
    fields above went away.
  - `DiscoverFilter.session` — subsumed by `DiscoverFilter.session_name`.
  - `AgentInfo.session` and `Agent.session` properties.

  Migration:

  ```diff
  - service = AgentService(agent="hermes", owner="rene", name="default", session="alice", nc=nc)
  + service = AgentService(agent="hermes", owner="rene", session_name="alice", nc=nc)

  - async for msg in agent.prompt("hi", session="alice"):
  + filt = DiscoverFilter(session_name="alice")
  + [agent] = await agents.discover(filter=filt)
  + async for msg in agent.prompt("hi"):
  ```

### Changed (wire-breaking)

- **Wire moves to verb-first subjects (protocol v0.3).** The agent
  subject hierarchy gains a verb token directly after the root so each
  endpoint owns its own positional slot, leaving room for new endpoints
  without sub-subject suffixes:

  | endpoint  | v0.2 wire                         | v0.3 wire (this release) |
  | --------- | --------------------------------- | ------------------------ |
  | prompt    | `agents.{a}.{o}.{n}`              | `agents.prompt.{a}.{o}.{n}` |
  | heartbeat | `agents.{a}.{o}.{n}.heartbeat`    | `agents.hb.{a}.{o}.{n}` (verb abbreviated; heartbeats dominate per-account subject volume) |
  | status    | —                                 | `agents.status.{a}.{o}.{n}` (new) |

  `AgentSubject` exposes `prompt`, `heartbeat`, and `status` properties
  that build the new shapes. The legacy `inbox` property survives as a
  backwards-name-compat alias of `prompt` to keep the diff small for
  examples and tests; expect it to retire in a future cleanup PR.
- **`metadata.protocol_version` `"0.2"` → `"0.3"`.** Old v0.2 callers
  advertise `"0.2"` and therefore won't match a v0.3 agent's subjects;
  discovery filters via metadata make the mismatch a hard refusal
  rather than a silent talk-past. There is no back-compat shim — 0.x
  permits breaking changes per protocol §11.2.
- **Heartbeat tracker subscribes to `agents.hb.*.*.*`** (the exported
  `HEARTBEAT_SUBJECT` constant). The tracker still keys on
  `payload.instance_id` per §8.3, so observable behaviour is identical
  once both sides speak v0.3.

### Added

- **`status` request/response endpoint (§8.7 (v0.3)).** Every
  `AgentService` registers an additional NATS micro endpoint named
  `status` on `agents.status.{a}.{o}.{n}` (queue group `"agents"`).
  Replies with the same JSON payload shape as a heartbeat
  (`HeartbeatPayload`, §8.3) constructed fresh on each request — future
  PRs extend the response with richer agent metadata in one place,
  shared with the heartbeat publisher via the new
  `build_heartbeat_payload(...)` helper. Request body is currently
  ignored (no request schema yet). Exported sibling constants:
  `STATUS_ENDPOINT_NAME`, `STATUS_QUEUE_GROUP`.
- **`AgentSubject.prompt` / `.status` properties.** Sit alongside the
  existing `.heartbeat`. `parse_agent_subject(subject, verb=...)` gains
  a verb filter (default `VERB_PROMPT`) so callers can parse heartbeat
  / status subjects through the same helper.

### Anticipated companion work (not in this release)

This SDK ships **ahead** of the protocol spec and the TypeScript SDK,
mirroring the same shape the v0.2 alignment took. The following land
separately:

- **TS SDK at `client-sdk/typescript/`** picks up the same wire change
  + `protocol_version = "0.3"` + `status` endpoint registration. Until
  it does, `tests/test_interop_e2e.py` skips at module level with a
  pointed reason — removing the skip is the only action needed once TS
  catches up.
- **All agent harnesses under `agents/*`** (`agents/pi/`,
  `agents/openclaw/`, `agents/claude-code/`) hard-code the protocol
  version string and use raw `@nats-io/*` to publish heartbeats / serve
  prompts; each picks up the new subject layout independently.
- **The protocol spec** at
  [`synadia-ai/nats-agent-sdk-docs`](https://github.com/synadia-ai/nats-agent-sdk-docs)
  gains the v0.3 verb-first subject hierarchy (§2), the `status`
  endpoint section, and the bumped `metadata.protocol_version`.
- **Root-level `README.md`** and any monorepo-wide docs that show the
  old subject layout move in lockstep with the spec change.

### Changed (breaking, package-rename, prior entry)

- **PyPI distribution renamed `natsagent` → `synadia-ai-agents`.**
  Mirrors the TypeScript sibling on npm (`@synadia-ai/agents`) so users
  comparing the two SDKs see matching package names. Nothing was ever
  published to PyPI under the old name, so no deprecation shim ships.
- **Import path `natsagent` → `synadia_ai.agents`.** The SDK now lives
  inside a [PEP 420 implicit namespace package](https://peps.python.org/pep-0420/)
  rooted at `synadia_ai/`, leaving room for future siblings (`synadia-ai-foo`
  → `synadia_ai.foo`) without conflict. There is no `__init__.py` at
  `src/synadia_ai/`; mypy's `namespace_packages = true` and
  `explicit_package_bases = true` are set in `pyproject.toml` to support
  the layout.
- **Logger root `natsagent` → `synadia_ai.agents`.** Callers configuring
  per-logger handlers/levels must update their selectors (e.g.
  `logging.getLogger("natsagent.discovery")` →
  `logging.getLogger("synadia_ai.agents.discovery")`).

The public API surface is **unchanged** — every symbol in `__all__`
keeps its name, every signature and behavior is preserved. Migration is
mechanical:

```diff
- from natsagent import Agents
+ from synadia_ai.agents import Agents
```

```diff
- pip install natsagent
+ pip install synadia-ai-agents
```

## [0.3.0] - 2026-04-27

Aligns the Python caller surface with the TypeScript SDK's
[PR #7](https://github.com/synadia-ai/synadia-agents/pull/7) reshape: a
single `Agents` class that takes a caller-owned `NatsConnection`,
discovery returns directly-callable `Agent[]` (no `bind()` step), and
the `connect()`/`attach()` factories are gone in favor of a thin
`load_context_options()` helper. The Python SDK package version skips
straight from 0.2.x to 0.3.0; the wire protocol is unchanged at `0.2`.

This is an API-only break — every wire byte stays the same, so v0.3
agents and v0.2 callers (and vice versa) interoperate. The interop
test (`tests/test_interop_e2e.py`) round-trips a prompt through the TS
reference agent on the same wire.

### Changed (breaking)

- **`Client` → `Agents`.** Construct with kw-only `nc=`; the SDK no
  longer opens NATS connections — callers build a
  `nats.aio.client.Client` via `nats.connect(...)` and hand it to
  `Agents(nc=nc)`. `Agents.close()` tears down SDK-owned state only
  (heartbeat wildcard sub, in-flight stream cancellation); the
  underlying connection is the caller's responsibility. Mirrors what
  every other `@nats-io/*` library does (`jetstream(nc)`, `Svcm(nc)`,
  `Kvm(nc)`…).
- **`agents.discover()` returns a live `list[Agent]`.** Each `Agent`
  is directly callable — no `bind()` step. `DiscoveredAgent` and
  `RemoteAgent` are merged into a single `Agent` class that carries
  both the parsed `$SRV.INFO` metadata (flat fields: `instance_id`,
  `agent`, `owner`, `name`, `session`, `protocol_version`,
  `description`, `version`, `metadata`, `endpoints`, `prompt_endpoint`,
  `prompt_subject`) and the `.prompt()` method.
- **Server-side `Agent` → `AgentService`.** Full rename — file moves
  from `src/synadia_ai/agents/agent.py` to `src/synadia_ai/agents/service.py`,
  exported as `AgentService` from the package root. **Hermes is the
  affected downstream consumer**; behaviour, signature, and
  constructor kwargs are unchanged.
- **`Agents.discover()` defaults to the stall strategy.** Returns
  ~200 ms after the most recent reply, with a 2 s absolute safety cap,
  so interactive paths feel snappy instead of always blocking the
  full window. Pass `timeout=...` to switch back to the timer
  strategy for deterministic scans. New constants exported:
  `DEFAULT_DISCOVER_STALL_S = 0.2`, `DEFAULT_DISCOVER_MAX_WAIT_S = 2.0`.
- **`Agents.liveness(instance_id)` replaces `Client.status(inbox)`.**
  Returns a frozen `Liveness` snapshot or `None`; `is_online` is
  precomputed at read time against `DEFAULT_LIVENESS_SLACK *
  interval_s`. Heartbeat tracker storage is keyed on
  `payload.instance_id` (§8.3), not the heartbeat subject — multiple
  instances of the same logical agent are now distinguishable.
- **`Agents.ping(instance_id)` is per-instance (§8.4).** The previous
  `Client.ping()` was a global PING that said nothing about a
  specific instance; the per-instance `$SRV.PING.agents.{id}` form is
  the spec-supported reachability check. Use
  `len(agents.discover(timeout=...))` for "is anyone there".
- **Heartbeat wildcard fixed.** The tracker subscribes to
  `agents.*.*.*.heartbeat` (exported as `HEARTBEAT_SUBJECT`).
- **Single `NatsContextError` class.** Replaces
  `ContextNotFoundError`, `ContextInvalidError`, `ContextNotSelectedError`,
  and `ContextNotSupportedError`. Branch on the class, not on
  more-specific subtypes; the message carries actionable detail.

### Added

- **`load_context_options(selector)`** — translate a `nats` CLI context
  into kwargs for `nats.connect(...)`. Returns a dict with `servers`,
  plus `token` / `user` / `password` / `user_credentials` /
  `user_jwt_cb` / `inbox_prefix` when the context declared them. Pass
  `"current"` to honour `$NATS_CONTEXT` → the `context.txt` selection
  pointer. Auth precedence: `creds` > `user_jwt` > `token` /
  `user`+`password`. `nkey`, TLS triple, and `nsc://...` URLs raise
  `NatsContextError` with an actionable message.
- **`AgentInfo`** — pure data record returned by `build_agent_info()`;
  what `Agent` wraps. Carries flat identity fields plus `metadata`,
  `endpoints`, and `prompt_endpoint`. Mirrors the TS `AgentInfo`
  interface.
- **`build_agent_info(info: dict) -> AgentInfo | None`** — public
  helper for materialising an `AgentInfo` from a parsed `$SRV.INFO`
  dict (e.g. obtained via a heartbeat + `$SRV.INFO.agents.{id}`
  direct lookup).
- **`DiscoverFilter`** — AND-matched identity filter for
  `Agents.discover(filter=...)`: `agent`, `owner`, `name`, `session`,
  `protocol_version`.
- **`Liveness`** — frozen-snapshot dataclass with
  `instance_id`, `last_seen`, `interval_s`, `is_online`.
- **Constants exported from the package root**: `SERVICE_NAME`,
  `PROMPT_QUEUE_GROUP`, `PROMPT_ENDPOINT_NAME`, `HEARTBEAT_SUBJECT`,
  `DEFAULT_LIVENESS_SLACK`, `DEFAULT_DISCOVER_STALL_S`,
  `DEFAULT_DISCOVER_MAX_WAIT_S`, `DEFAULT_STREAM_INACTIVITY_TIMEOUT_S`.
- **Per-instance heartbeat listeners.** `agents.on_heartbeat(instance_id,
  listener)` returns an unsubscribe function; the listener fires once
  per matching beat in registration order.

### Removed

- **`Client`, `RemoteAgent`, `DiscoveredAgent`, `Agent`** (old
  server-side class). The first three merge into `Agent` (client-side)
  + `AgentInfo`; the old server-side `Agent` is now `AgentService`.
- **`Client.bind()`** — discovery returns live handles directly.
  Callers with a config-driven set of target agents discover once and
  match by metadata via `DiscoverFilter` or a list comprehension.
- **`synadia_ai.agents.connect()` and `NatsContext`.** Replaced by
  `nats.connect(**load_context_options(...))`. The SDK does not own a
  connection factory; callers do.
- **`AgentStatus`** — replaced by `Liveness` (frozen, snapshot-style).
- **`ContextNotFoundError`, `ContextInvalidError`,
  `ContextNotSelectedError`, `ContextNotSupportedError`** — collapsed
  into `NatsContextError`.

### Migration

Caller — connect, discover, prompt:

```diff
- import synadia_ai.agents
- from synadia_ai.agents import Client
-
- nc = await synadia_ai.agents.connect(servers="nats://127.0.0.1:4222")
- client = Client(nc)
- await client.start()
- found = await client.discover(timeout=2.0)
- remote = client.bind(found[0])
- async for msg in remote.prompt("hi"):
-     ...
- await client.stop()
- await nc.close()
+ import nats
+ from synadia_ai.agents import Agents
+
+ nc = await nats.connect(servers="nats://127.0.0.1:4222")
+ agents = Agents(nc=nc)
+ found = await agents.discover()              # stall by default
+ async for msg in found[0].prompt("hi"):
+     ...
+ await agents.close()                         # SDK state only
+ await nc.close()                             # caller owns this
```

Caller — context resolution:

```diff
- nc = await synadia_ai.agents.connect(context="prod")
+ import nats
+ from synadia_ai.agents import load_context_options
+ nc = await nats.connect(**load_context_options("prod"))
```

Server (Hermes-style harness):

```diff
- from synadia_ai.agents import Agent
- service = Agent(agent="hermes", owner="alice", name="alice-1", nc=nc)
+ from synadia_ai.agents import AgentService
+ service = AgentService(agent="hermes", owner="alice", name="alice-1", nc=nc)
  service.on_prompt(handler)
  await service.start()
```

Liveness / heartbeat:

```diff
- status = client.status(agent.inbox)
- if status.is_online():
+ liveness = agents.liveness(agent.instance_id)
+ if liveness is not None and liveness.is_online:
      ...
```

Per-instance ping:

```diff
- # `Client.ping()` was global — said nothing about a specific instance.
- ok = await client.ping(timeout=2.0)
+ ok = await agents.ping(agent.instance_id, timeout=2.0)
```

### Fixed (post-review)

The reviewer-bot pass on the 0.3.0 reshape PR
([#22](https://github.com/synadia-ai/synadia-agents/pull/22)) flagged
seven correctness / hygiene issues plus one pre-existing follow-up.
All addressed in-PR before tagging:

- **`build_agent_info` now rejects empty `metadata.owner` /
  `metadata.protocol_version`** in addition to missing keys (§3.2). The
  previous `is None` checks let `""` through; tightened to the same
  falsy check already used for `metadata.agent`.
- **`Agent.prompt()` observes `Agents.close()` mid-stream.** The close
  event is now raced against `next_msg(timeout=...)` via
  `asyncio.wait(..., FIRST_COMPLETED)`, so `Agents.close()` interrupts
  an in-flight stream within one event-loop tick instead of waiting up
  to the per-chunk inactivity timeout (default 60 s). Regression
  coverage in `tests/test_close_e2e.py` (the test fails on the pre-fix
  code with elapsed ≈ 31 s and a "stream stalled" error).
- **`Liveness.is_online` boundary kept inclusive (`<=`).** A heartbeat
  that arrived exactly `slack * interval_s` seconds ago is considered
  online — matches the docstring's "within" wording and the pre-0.3
  `AgentStatus.is_online()` contract.
- **`Attachment.to_bytes()` now passes `validate=True`.** A non-
  compliant peer sending URL-safe base64 (`-` / `_`) or other non-
  alphabet bytes surfaces as `binascii.Error` instead of silently
  decoding to corrupted bytes.
- **`AgentService` reads its `version` from package metadata.**
  `service.py` no longer hardcodes `_SDK_VERSION`; it reads
  `importlib.metadata.version("synadia-ai-agents")` so `pyproject.toml` is the
  single source of truth across releases.
- **`HeartbeatTracker` listener storage switched from `set` to `list`.**
  Mirrors the TS SDK's array semantics: registering the same callable
  twice produces two independent registrations, and each unsubscribe
  removes one occurrence (idempotent thereafter). Previously the second
  registration was silently deduplicated.
- **`asyncio.get_event_loop()` → `asyncio.get_running_loop()`** inside
  `discovery.request_many_stall` — avoids the `DeprecationWarning`
  emitted in Python 3.12+ when the lookup runs from a coroutine.
- **`load_context_options(...)["inbox_prefix"]` is now `str`** to match
  what `nats.connect()` documents (`Union[str, bytes]`, default
  `b"_INBOX"`); the manual `.encode("utf-8")` is gone.

### Deferred for follow-up

- The 2026-04-26 TS-parity sweep deliberately deferred a handful of
  convenience features (session-name auto-resolution, attachment
  filesystem-staging helper) and surfaced two behavioural divergences
  (bare-string vs JSON-wrapped response chunks, no global TTL on
  mid-stream `ask()` queries). All catalogued in
  [`docs/protocol-mapping.md` › Deferred TS-parity work](docs/protocol-mapping.md#deferred-ts-parity-work)
  with rationale + a suggested next step for each, so the team can
  pick them up in a follow-up PR.

### Added

- **`Agent(keepalive_interval_s=...)` — automatic per-request keep-alive
  ack.** While a prompt handler is running, the agent now emits
  `{"type":"status","data":"ack"}` (§6.4) every `keepalive_interval_s`
  seconds, matching the behaviour every TS reference harness
  (`agents/pi/`, `agents/claude-code/`, `agents/openclaw/`) implements
  inline. This prevents callers using a stream inactivity timeout (the
  TS SDK default is 60 s) from giving up on Python agents whose
  handlers do real work between response chunks. Defaults to **30 s**;
  pass `keepalive_interval_s=None` to disable (e.g. when the handler
  emits its own status chunks at a finer cadence). Constructor
  validates `> 0` or `None`. Covered by `tests/test_keepalive_e2e.py`.

### Fixed

- **Reject NUL bytes in `nats` CLI context names.** `synadia_ai.agents.connect(context=...)`
  now raises `ContextInvalidError` when the resolved name contains
  `\x00`, instead of letting it propagate into `Path` and surface as a
  confusing `ValueError: embedded null byte`. Brings the validator into
  full parity with the TS SDK's `loadContextOptions` path-traversal
  guard (PR #17 on the TS side). Other separators (`/`, `\`), ``..``
  components, and leading-dot names were already rejected.

## [0.2.0] - 2026-04-22

Aligns the SDK with **NATS Agent Protocol v0.2** (draft dated
2026-04-21). v0.2 is explicitly wire-incompatible with v0.1 per spec
§11.3 - the service name changes, the `prompt` endpoint must carry a
specific queue group, and `metadata.protocol_version` bumps to `"0.2"`.
There is no back-compat shim; 0.x permits breaking changes per §11.2.

### Changed (wire-breaking)

- **§3.1 service name `SynadiaAgents` → `agents`.** Every compliant
  agent now registers under the single shared name `agents`. Callers
  filter `$SRV.INFO` responses on that exact value.
- **§4.1 general discovery - `$SRV.PING.SynadiaAgents` → `$SRV.PING.agents`**
  (and `$SRV.INFO.SynadiaAgents` → `$SRV.INFO.agents`). Used by
  `Client.discover()` and `Client.ping()`.
- **§4.2 direct lookup - `$SRV.INFO.SynadiaAgents.{id}` → `$SRV.INFO.agents.{id}`.**
- **§3.3 `prompt` endpoint MUST be registered with queue group `"agents"`.**
  The v0.1 spec left the queue group unspecified, so SDKs silently used
  their framework's default (`"q"` in nats-py, distinct in other
  clients) - mixed-SDK deployments therefore failed to load-balance.
  v0.2 pins the spec value explicitly; the Python SDK wires it into the
  `EndpointConfig(...)` used by `Agent.start()`.
- **§3.2 `metadata.protocol_version` `"0.1"` → `"0.2"`.** Declared in
  service registration; callers compare MAJOR.MINOR only (§11.1).

### Added

- **`Envelope.session` (§5.6 convention)** - optional caller-supplied
  conversation label carried on the request envelope. Session-aware
  harnesses (Hermes, pi, ...) use it to pin multi-turn conversations
  across requests; session-agnostic agents ignore it. v0.2's §5.1 no
  longer defines `session` as a first-class envelope field; the same
  §5.6 extension-field preservation rules that apply to any unknown
  top-level key keep it round-trippable. `RemoteAgent.prompt` gains a
  keyword-only `session: str | None = None` argument that composes with
  both bare-string and `Envelope` entry points. When both an `Envelope`
  with a `session` and an explicit `session=` kwarg are supplied, the
  kwarg wins (principle of least surprise - caller's call takes
  precedence). The `session` bytes count toward the `max_payload` size
  check (§5.4) - verified by
  `tests/test_validation_e2e.py::test_payload_size_includes_session`.
  Examples `02-prompt-text.py`, `03-prompt-attachment.py`, and
  `04-query-reply.py` gain a `--session NAME` flag; `_reference_agent.py`
  logs and echoes the received session so end-to-end runs have visible
  evidence.
- **`Envelope` preserves unknown top-level fields on decode → encode
  (§5.6).** `extra="ignore"` → `extra="allow"`. Future extension fields
  like `"x-trace-id"` round-trip cleanly instead of being silently
  dropped by relays that re-serialize through this model. Covered by
  `tests/test_envelope.py::TestUnknownFieldPreservation`.
- **`examples/_reference_agent.py` - per-session conversation memory.**
  Keys its in-process history on `envelope.session`, with a shared
  `None` bucket for session-less callers. Demonstrates both layers of
  the protocol's session model in one agent: subject-level chat (the
  NATS subject IS the session boundary - §2 + §3.2) and envelope-level
  multiplexing (`--session NAME` over a single shared subject - §5.6
  tolerated convention). Capped at 20 turns/session to keep
  long-running demos honest about memory. Covered by
  `tests/test_session_memory_e2e.py`.
- **`examples/06-chat.py` - interactive chat REPL.** `rich`-powered TUI
  with colored turn markers, streaming output, a "thinking…" spinner,
  readline history, and `/quit` / `/clear` / `/help` slash commands.
  Without `--session` drives a subject-level chat; with `--session NAME`
  drives one of many envelope-level conversations on the same subject.
  Requires the new `[project.optional-dependencies].examples` extra -
  install with `uv sync --extra examples`. Parser covered by
  `tests/test_chat_commands.py`.
- **`synadia_ai.agents.connect()`** - NATS connection factory with three
  variants: direct `servers=` URL(s), `context=` (nats-cli JSON at
  `~/.config/nats/context/<name>.json`, XDG-compliant; pass `True` or
  `"current"` to honour `$NATS_CONTEXT` → the selection pointer written
  by `nats context select`), and `nc=` caller-owned passthrough.
  Context-field support matches the TS SDK v0.1.0: `url`, `token`,
  `user`/`password`, `creds`, `user_jwt`, `inbox_prefix`, `description`.
  Unsupported fields (`nkey`, TLS triple, `nsc`) raise
  `ContextNotSupportedError` with an actionable message. The SDK itself
  does NOT read `NATS_URL` - that stays a convenience default in
  `examples/`. New exports: `connect`, `NatsContext`,
  `ContextNotFoundError`, `ContextNotSelectedError`,
  `ContextInvalidError`, `ContextNotSupportedError`.
- **`examples/`** - six user-facing demo scripts ported one-for-one from
  the TS SDK: `_reference_agent.py` (echoing agent with configurable
  prefix + attachment saving), `01-discover.py`, `02-prompt-text.py`,
  `03-prompt-attachment.py`, `04-query-reply.py`, `05-liveness.py`. All
  share a tiny `_connect_cli.py` helper that resolves `--context` /
  `--url` / `$NATS_URL` / selected-context in that order.
- **`DiscoveredAgent.protocol_version` / `.version`** - parsed from
  service metadata / the `$SRV.INFO` record so `01-discover.py` can
  print them alongside the endpoint caps. Additive; defaults to `""`.
- **Structured log records on three client I/O paths** (logger
  `synadia_ai.agents.client`): `debug` on `Client.ping` timeout, `warning` on
  prompt stream inactivity timeout, `warning` on service-error frames
  received mid-stream. Field-debugging visibility only - no wire
  change.

### Changed

- **`Client.ping()` no longer takes an `inbox` argument.** The method
  always pinged the shared `$SRV.PING.agents` subject globally; the
  `inbox` argument was validated but otherwise ignored, so the return
  value said nothing about whether *that specific* inbox was live.
  Callers wanting per-instance liveness should use
  `Client.status(inbox)` instead (heartbeat-tracked per §8.2). This is
  a pre-1.0 API break, permitted by protocol §11.2.

### Fixed

- **`Client.ping()` now returns `False` on `NoRespondersError`** - when
  the broker advertises the `no_responders` header (nats-server 2.x
  default) and zero subscribers match `$SRV.PING.agents`, nats-py
  raises `NoRespondersError` rather than `TimeoutError`. The previous
  `except TimeoutError` branch missed this path, so a ping against a
  broker with no compliant agent registered crashed instead of
  returning `False`. The e2e test suite masked this because the
  `EvidenceRecorder` fixture subscribes to `$SRV.>`, keeping the
  broker's no-responders fast-fail dormant.

### Migration from 0.1

Agents:

```diff
  agent = Agent(agent="demo", owner="alice", name="worker-1", nc=nc)
  # Internally:
- #   ServiceConfig(name="SynadiaAgents", metadata={"protocol_version": "0.1", ...})
- #   EndpointConfig(name="prompt", subject=..., handler=...)   # framework-default queue group
+ #   ServiceConfig(name="agents", metadata={"protocol_version": "0.2", ...})
+ #   EndpointConfig(name="prompt", subject=..., handler=..., queue_group="agents")
```

Callers using `nats` CLI or raw NATS:

```diff
- nats req  '$SRV.PING.SynadiaAgents' '' --replies=0 --timeout=2s
- nats req  '$SRV.INFO.SynadiaAgents' '' --replies=0 --timeout=2s
+ nats req  '$SRV.PING.agents' '' --replies=0 --timeout=2s
+ nats req  '$SRV.INFO.agents' '' --replies=0 --timeout=2s
```

v0.1 agents and v0.2 agents **do not interoperate**: the service names
differ, so discovery never sees the other side. Upgrade the agent and
caller as a pair.

### Interop

- The TypeScript SDK (`../typescript/`) was still on v0.1 at the time
  of this release. The test `tests/test_interop_e2e.py` `pytest.skip`s
  cleanly when its prereqs (`bun` on PATH, sibling `../typescript/`
  with `node_modules/`) are missing. The TS SDK has since caught up to
  protocol `0.2`; running the suite with the prereqs in place
  rounds-trips a prompt through the TS reference agent.

## [0.1.0] - 2026-04-21

First professional-polish release. Brings the SDK into full compliance
with the finalised **NATS Agent Protocol v0.1** and adds the
release-engineering artifacts a public project needs.

**This release is a clean break from 0.0.1** - both the wire format and
the public API change. There is no back-compat shim; 0.x permits
breaking changes per protocol §11.2. A migration guide is at the bottom
of this entry.

### Added

- **§3.1 service registration** - agents now register under service name
  `SynadiaAgents` (spec-mandated; the canonical `Synadia Agents` is
  equivalent but contains a space and is unusable in `$SRV.*.<name>`
  subjects).
- **§3.2 service metadata** - `{agent, owner, protocol_version, session?}`.
  `session` is optional and set via `Agent(session=...)` - required for
  session-aware harnesses (`claude-code`, `pi`, `hermes`).
- **§2.1 prompt endpoint metadata** - `Agent(max_payload=..., attachments_ok=...)`
  declared on the `prompt` endpoint. Parsed on the caller side into
  `DiscoveredAgent.prompt_endpoint.max_payload_bytes` and
  `.attachments_ok`.
- **§4 discovery** - `Client.discover()` now publishes
  `$SRV.INFO.SynadiaAgents` (to get endpoint subjects + capabilities in
  the same round trip) and filters responses by service name.
- **§8.3 heartbeat `instance_id`** - matches the nats-py micro service
  id; lets callers correlate liveness across multiple instances of the
  same identity tuple. Session field also propagates.
- **§5.4 pre-publish validation** - `RemoteAgent.prompt` synchronously
  rejects empty prompts, attachments-when-not-allowed, and oversize
  payloads BEFORE any wire I/O. New error classes: `ValidationError`,
  `PromptEmptyError`, `AttachmentsNotSupportedError`,
  `PayloadTooLargeError`. All share `NatsAgentError` as base.
- **§6.6 forward compatibility** - `decode_chunk` returns `None` for
  unknown chunk types, and the stream iterator silently drops them.
  Unknown envelope / chunk data fields are also tolerated.
- **§9.3 error completion** - agent-side error paths now emit the
  error-headered frame AND the trailing empty terminator as the spec
  requires. Client-side terminator detection requires empty body AND no
  headers.
- **`EndpointInfo` dataclass** exported as part of the public API -
  represents the parsed `$SRV.INFO` endpoint record.
- **`DiscoveredAgent.session`** - parsed from service metadata.
- **Cross-SDK interop test** - `tests/test_interop_e2e.py` spawns the
  TypeScript SDK's reference agent via `bun` and exercises Python ↔ TS
  on the same wire. Skips cleanly if `bun` or the sibling
  `../typescript/` checkout is missing.
- **`docs/protocol-mapping.md`** - every SDK call mapped to its spec
  section; mirrors the TypeScript SDK's equivalent doc.
- **`scripts/demo_echo.py`** - runnable reference agent for manual
  poking with the `nats` CLI.

### Changed

- **Envelope shape** - `{prompt: str, attachments: [{filename, content}]}`
  replaces the v0.0.1 `{parts: [TextPart | FilePart, ...]}`. `content`
  is RFC 4648 §4 base64 (standard alphabet, padded).
- **`Agent(platform=...)` → `Agent(agent=...)`** - see §2 spec rename.
- **`AgentSubject.platform` → `AgentSubject.agent`**; same for
  `DiscoveredAgent.platform`.
- **Stream chunks are JSON-only on the response side** - §6.2 forbids
  the plain-text shorthand on responses. `PromptStream.send(str)` now
  emits `{"type":"response","data":"<text>"}` instead of raw bytes;
  `decode_chunk` rejects non-JSON with `ProtocolError`.
- **`Client.bind(...)`** accepts either a `DiscoveredAgent` (full
  capability-aware handle with §5.4 checks) or a bare inbox subject
  string (legacy, no caps, no local validation). The inbox-only path is
  kept for CLI / testing ergonomics; production code should prefer the
  `DiscoveredAgent` path per spec §12.
- **Heartbeat payload shape** - `HeartbeatPayload` now has
  `{agent, owner, session?, instance_id, ts, interval_s}`. Previously:
  `{name, platform, owner, ts, interval_s}`.
- **Error description sanitation** - multi-line error messages
  (e.g. pydantic validation errors) are collapsed to single-line on the
  way into `Nats-Service-Error` headers, since NATS headers can't carry
  newlines.

### Removed

- **`TextPart`, `FilePart`, `Envelope.parts`** - replaced by `Envelope.prompt`
  + `Envelope.attachments` (§5.1).
- **`encode_response_text`, `wrap_text_as_response`** - unused once
  response-side plain-text shorthand is forbidden.
- **`metadata.type: "agent"`** service metadata field - the spec
  doesn't define it; agents are identified by service name instead.
- **`metadata.platform`** - replaced by `metadata.agent` (§3.2).
- **`metadata.protocol`** - replaced by `metadata.protocol_version` (§3.2).

### Migration from 0.0.1

```diff
- agent = Agent(platform="claude-code", owner="alice", name="worker-1", nc=nc)
+ agent = Agent(agent="claude-code", owner="alice", name="worker-1", nc=nc)
```

```diff
- envelope = Envelope(parts=[TextPart(content="hi"), FilePart.from_bytes("x.pdf", data)])
+ envelope = Envelope(prompt="hi", attachments=[Attachment.from_bytes("x.pdf", data)])
```

```diff
- async def handler(envelope, stream):
-     for part in envelope.parts:
-         if isinstance(part, TextPart):
-             await stream.send(f"echo: {part.content}")
+ async def handler(envelope, stream):
+     await stream.send(f"echo: {envelope.prompt}")
```

```diff
- remote = client.bind(inbox_str)
+ found = await client.discover()
+ discovered = next(d for d in found if d.inbox == inbox_str)
+ remote = client.bind(discovered)   # now validates §5.4 locally
```

```diff
  # caller handling of errors is unchanged - ProtocolError raised from iterator
  # NEW: pre-publish validation errors are raised synchronously from .prompt()
+ try:
+     async for msg in remote.prompt(text, attachments=[...]):
+         ...
+ except AttachmentsNotSupportedError:
+     # the agent declared attachments_ok=false; we failed locally
+     ...
+ except PayloadTooLargeError as exc:
+     # payload exceeded agent's max_payload
+     print(exc.limit, exc.actual)
```

## [0.0.1] - 2025-10-15

Initial scaffold. Released ahead of the finalised v0.1 spec; most wire
shapes in this version no longer match the spec and are corrected in
0.1.0.

[Unreleased]: https://github.com/synadia-ai/synadia-agents/compare/python-v0.3.0...HEAD
[0.3.0]: https://github.com/synadia-ai/synadia-agents/releases/tag/python-v0.3.0
[0.2.0]: https://github.com/synadia-ai/synadia-agents/releases/tag/python-v0.2.0
[0.1.0]: https://github.com/synadia-ai/synadia-agents/releases/tag/python-v0.1.0
[0.0.1]: https://github.com/synadia-ai/synadia-agents/releases/tag/python-v0.0.1

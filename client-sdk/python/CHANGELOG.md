# Changelog

All notable changes to `natsagent` are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
the 0.x line is explicitly unstable per protocol spec §11.2.

## [Unreleased]

### Fixed

- **Reject NUL bytes in `nats` CLI context names.** `natsagent.connect(context=...)`
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
- **`natsagent.connect()`** - NATS connection factory with three
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
  `natsagent.client`): `debug` on `Client.ping` timeout, `warning` on
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

- The TypeScript SDK (`../typescript/`) is still on v0.1 at the time
  of this release. `tests/test_interop_e2e.py` is marked `xfail` until
  the TS SDK bumps to v0.2; a future TS v0.2 release will flip this
  back to green (`XPASS` surfaces as a test-suite signal).

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

[Unreleased]: https://github.com/synadia-ai/synadia-agents/compare/python-v0.2.0...HEAD
[0.2.0]: https://github.com/synadia-ai/synadia-agents/releases/tag/python-v0.2.0
[0.1.0]: https://github.com/synadia-ai/synadia-agents/releases/tag/python-v0.1.0
[0.0.1]: https://github.com/synadia-ai/synadia-agents/releases/tag/python-v0.0.1

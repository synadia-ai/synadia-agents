# Changelog

All notable changes to `natsagent` are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
the 0.x line is explicitly unstable per protocol spec §11.2.

## [Unreleased]

_Nothing yet._

## [0.1.0] - 2026-04-21

First professional-polish release. Brings the SDK into full compliance
with the finalised **NATS Agent Protocol v0.1** and adds the
release-engineering artifacts a public project needs.

**This release is a clean break from 0.0.1** — both the wire format and
the public API change. There is no back-compat shim; 0.x permits
breaking changes per protocol §11.2. A migration guide is at the bottom
of this entry.

### Added

- **§3.1 service registration** — agents now register under service name
  `SynadiaAgents` (spec-mandated; the canonical `Synadia Agents` is
  equivalent but contains a space and is unusable in `$SRV.*.<name>`
  subjects).
- **§3.2 service metadata** — `{agent, owner, protocol_version, session?}`.
  `session` is optional and set via `Agent(session=...)` — required for
  session-aware harnesses (`claude-code`, `pi`, `hermes`).
- **§2.1 prompt endpoint metadata** — `Agent(max_payload=..., attachments_ok=...)`
  declared on the `prompt` endpoint. Parsed on the caller side into
  `DiscoveredAgent.prompt_endpoint.max_payload_bytes` and
  `.attachments_ok`.
- **§4 discovery** — `Client.discover()` now publishes
  `$SRV.INFO.SynadiaAgents` (to get endpoint subjects + capabilities in
  the same round trip) and filters responses by service name.
- **§8.3 heartbeat `instance_id`** — matches the nats-py micro service
  id; lets callers correlate liveness across multiple instances of the
  same identity tuple. Session field also propagates.
- **§5.4 pre-publish validation** — `RemoteAgent.prompt` synchronously
  rejects empty prompts, attachments-when-not-allowed, and oversize
  payloads BEFORE any wire I/O. New error classes: `ValidationError`,
  `PromptEmptyError`, `AttachmentsNotSupportedError`,
  `PayloadTooLargeError`. All share `NatsAgentError` as base.
- **§6.6 forward compatibility** — `decode_chunk` returns `None` for
  unknown chunk types, and the stream iterator silently drops them.
  Unknown envelope / chunk data fields are also tolerated.
- **§9.3 error completion** — agent-side error paths now emit the
  error-headered frame AND the trailing empty terminator as the spec
  requires. Client-side terminator detection requires empty body AND no
  headers.
- **`EndpointInfo` dataclass** exported as part of the public API —
  represents the parsed `$SRV.INFO` endpoint record.
- **`DiscoveredAgent.session`** — parsed from service metadata.
- **Cross-SDK interop test** — `tests/test_interop_e2e.py` spawns the
  TypeScript SDK's reference agent via `bun` and exercises Python ↔ TS
  on the same wire. Skips cleanly if `bun` or the sibling
  `../typescript/` checkout is missing.
- **`docs/protocol-mapping.md`** — every SDK call mapped to its spec
  section; mirrors the TypeScript SDK's equivalent doc.
- **`scripts/demo_echo.py`** — runnable reference agent for manual
  poking with the `nats` CLI.

### Changed

- **Envelope shape** — `{prompt: str, attachments: [{filename, content}]}`
  replaces the v0.0.1 `{parts: [TextPart | FilePart, ...]}`. `content`
  is RFC 4648 §4 base64 (standard alphabet, padded).
- **`Agent(platform=...)` → `Agent(agent=...)`** — see §2 spec rename.
- **`AgentSubject.platform` → `AgentSubject.agent`**; same for
  `DiscoveredAgent.platform`.
- **Stream chunks are JSON-only on the response side** — §6.2 forbids
  the plain-text shorthand on responses. `PromptStream.send(str)` now
  emits `{"type":"response","data":"<text>"}` instead of raw bytes;
  `decode_chunk` rejects non-JSON with `ProtocolError`.
- **`Client.bind(...)`** accepts either a `DiscoveredAgent` (full
  capability-aware handle with §5.4 checks) or a bare inbox subject
  string (legacy, no caps, no local validation). The inbox-only path is
  kept for CLI / testing ergonomics; production code should prefer the
  `DiscoveredAgent` path per spec §12.
- **Heartbeat payload shape** — `HeartbeatPayload` now has
  `{agent, owner, session?, instance_id, ts, interval_s}`. Previously:
  `{name, platform, owner, ts, interval_s}`.
- **Error description sanitation** — multi-line error messages
  (e.g. pydantic validation errors) are collapsed to single-line on the
  way into `Nats-Service-Error` headers, since NATS headers can't carry
  newlines.

### Removed

- **`TextPart`, `FilePart`, `Envelope.parts`** — replaced by `Envelope.prompt`
  + `Envelope.attachments` (§5.1).
- **`encode_response_text`, `wrap_text_as_response`** — unused once
  response-side plain-text shorthand is forbidden.
- **`metadata.type: "agent"`** service metadata field — the spec
  doesn't define it; agents are identified by service name instead.
- **`metadata.platform`** — replaced by `metadata.agent` (§3.2).
- **`metadata.protocol`** — replaced by `metadata.protocol_version` (§3.2).

### Migration from 0.0.1

```diff
- agent = Agent(platform="ccc", owner="alice", name="worker-1", nc=nc)
+ agent = Agent(agent="ccc", owner="alice", name="worker-1", nc=nc)
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
  # caller handling of errors is unchanged — ProtocolError raised from iterator
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

[Unreleased]: https://github.com/synadia-io/nats-ai-pysdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/synadia-io/nats-ai-pysdk/releases/tag/v0.1.0
[0.0.1]: https://github.com/synadia-io/nats-ai-pysdk/releases/tag/v0.0.1

# Changelog

All notable changes to `@synadia-ai/nats-claude-code-headless` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Optional connection-bound service identity through `senderIdentity` /
  `NATS_SENDER_IDENTITY`, plus independent signed-only prompt admission through
  `minSenderTrust` / `NATS_MIN_SENDER_TRUST`. Defaults remain identity off and
  trust any.
- **Identity env vars adopt the `SYNADIA_*` convention** shared with
  `agents/*`: `CLAUDE_CODE_HEADLESS_OWNER|NAME` resolve as CLI flag >
  `SYNADIA_CLAUDE_CODE_HEADLESS_OWNER|NAME` (per-agent) > `SYNADIA_OWNER|NAME`
  (fleet-wide) > `CLAUDE_CODE_HEADLESS_OWNER|NAME` (legacy, keeps working) >
  derived owner / configured name fallback.

### Changed

- Migrated the controller and every logical Claude session from hand-rolled or
  testing-only services to production `AgentService`. The controller retains
  `spawn`, `stop`, and `list` through `extraEndpoints`; prompt admission,
  replay protection, status classification, acknowledgements, keep-alives,
  heartbeats, errors, and termination now use the shared implementation.
- All services derive identity from the one immutable connection credential
  snapshot and share that connection's signer. Logical sessions are separate
  routing/conversation instances, not separate cryptographic identities.
- Permission questions now use `PromptResponse.ask()`.
- Pinned the already-locked Claude Agent SDK, NATS, build, TypeScript, and type
  package versions; removed mutable `latest` and external range selectors.

### Security

- **Transitive dependency refresh in `bun.lock`** (no `package.json`
  change; prompted by synadia-ai/synadia-agents#179). Bumped the
  vulnerable transitive packages pulled in via
  `@anthropic-ai/claude-agent-sdk` → `@modelcontextprotocol/sdk`:
  `fast-uri` 3.1.2 → 3.1.6 (host confusion / IDN canonicalization,
  CVE-2026-13676 and related advisories), `hono` 4.12.18 → 4.13.5,
  `@hono/node-server` 1.19.14 → 1.19.17, `body-parser` 2.2.2 → 2.3.0,
  `qs` 6.15.1 → 6.15.3, `ip-address` 10.2.0 → 10.5.0 (plus the
  `type-is` / `content-type` / `side-channel` entries those require).
  Every new version was checked against its upstream repository
  (npm provenance attestation or `gitHead` ↔ release tag) before
  pinning. Exposure was low to begin with — this example never uses
  `@modelcontextprotocol/sdk` directly (it arrives via the Claude Agent
  SDK) and serves no HTTP, which is what these packages back — but
  `bun audit` is now clean.

## [0.5.4] - 2026-05-11

### Changed

- **Protocol rename.** Every reference to "NATS Agent Protocol" in
  this package's prose and package metadata now reads **Synadia Agent
  Protocol for NATS**. No code, wire shape, or protocol version
  (`0.3`) change.

## [0.5.3] - 2026-05-04

### Changed

- **Lower heartbeat cadence from 30 s to 5 s** on both the controller
  and its spawned sessions. The dashboard's stale-eviction loop runs
  at `3 × intervalS`, so dead controllers / sessions disappear from
  the grid in ~15 s instead of ~90 s. The SDK's
  `DEFAULT_HEARTBEAT_INTERVAL_S` stays at 30 s as a sensible
  third-party default; this is a per-package opt-in.

## [0.5.2] - 2026-05-04

### Fixed

- **Reject prompts to expired sessions.** `handlePrompt` now responds
  with `Nats-Service-Error-Code: 410 session expired` (plus the §6.5
  empty terminator) when the session's lifetime has run out but the
  manager's sweep loop hasn't disposed it yet. Previously, a prompt
  that arrived between expiry and the next sweep tick was served
  normally — the session accepted work it was about to drop. The
  session itself is unchanged; the guard only refuses new requests.
- **Reject prompts to disposed sessions with `503 session stopped`.**
  The pre-existing `disposed` short-circuit emitted only a §6.5
  terminator — indistinguishable on the wire from "stream completed
  cleanly with no chunks." Now sends an error header first so callers
  can tell "session was stopped" apart from "session ran and produced
  no output."

### Changed

- **Tighten the session-manager sweep cadence from 30 s to 2 s.**
  Combined with the `expired()` prompt guard, an expired session is
  disposed and unregistered from NATS within a couple of seconds of
  hitting its limit instead of up to 30 s.

## [0.5.1] - 2026-05-04

### Changed

- **Advertise the broker's negotiated `max_payload`** instead of a
  hardcoded `"1MB"`. The controller's prompt endpoint reads
  `nc.info.max_payload` directly (controllers register via `Svcm`,
  not the SDK class) and surfaces the live value (e.g. `"8MB"` on
  NGS) in `$SRV.INFO`. Spawned sessions get the same behavior for
  free now that `@synadia-ai/agent-service`'s `ReferenceAgent`
  defaults `max_payload` to `nc.info.max_payload` when no
  `maxPayload` option is passed. Matches the pattern already used by
  `agents/pi` and `agents/claude-code`.

## [0.5.0] - 2026-05-04

> **Breaking:** wire shape changes for the controller's extension
> endpoints (`spawn`, `stop`, `list`) and the agent token used by both
> the controller and its spawned sessions. Callers that hard-coded the
> old subjects need to update.

### Changed (breaking)

- **Verb-first throughout.** Extension endpoints move from
  `agents.<agent>.<owner>.<name>.<verb>` to
  `agents.<verb>.<agent>.<owner>.<name>`, matching the protocol's verb-
  first layout for `prompt` / `hb` / `status`. Net effect: any tracer
  or audit layer can subscribe to `agents.<verb>.>` and parse identity
  positionally for both protocol and extension traffic.
- **Agent token rename.** `metadata.agent` and the 3rd subject token
  flip from `cc` to `cc-headless` for both the controller and its
  spawned sessions. This separates the headless example from the
  standalone `agents/claude-code/` runtime (which keeps `cc`, the
  inverse-direction MCP-driven NATS client).
- **Metadata simplification.** `metadata.role = "claude-code-headless-controller"`
  becomes `metadata.role = "controller"`; sessions now carry
  `metadata.role = "session"`. The redundant `metadata.spawner` field
  is dropped — the `agent` token already disambiguates.
- **Default controller name** flips from `exec` to `control`. On
  startup the controller probes `$SRV.INFO.agents` and picks the next
  free `<name>-N` if its target prompt subject is already claimed, so
  two claude-code-headless processes booted with default settings
  yield `control` and `control-2` automatically.

### Subject migration

| from | to |
| --- | --- |
| `agents.prompt.cc.<owner>.<name>` | `agents.prompt.cc-headless.<owner>.<name>` |
| `agents.hb.cc.<owner>.<name>` | `agents.hb.cc-headless.<owner>.<name>` |
| `agents.status.cc.<owner>.<name>` | `agents.status.cc-headless.<owner>.<name>` |
| `agents.cc.<owner>.<name>.spawn` | `agents.spawn.cc-headless.<owner>.<name>` |
| `agents.cc.<owner>.<name>.stop` | `agents.stop.cc-headless.<owner>.<name>` |
| `agents.cc.<owner>.<name>.list` | `agents.list.cc-headless.<owner>.<name>` |
| `agents.prompt.cc.<owner>.<session_id>` | `agents.prompt.cc-headless.<owner>.<session_id>` |
| `agents.hb.cc.<owner>.<session_id>` | `agents.hb.cc-headless.<owner>.<session_id>` |
| `agents.status.cc.<owner>.<session_id>` | `agents.status.cc-headless.<owner>.<session_id>` |

### SDK

Bumps `@synadia-ai/agents` and `@synadia-ai/agent-service` pins to
`^0.5.0`.

# Changelog

All notable changes to `@synadia-ai/nats-pi-headless` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.5] - 2026-05-12

### Changed

- **Track upstream PI package rename to `@earendil-works`.** PI moved
  to the Earendil Works organisation (see
  <https://pi.dev/news/2026/5/7/pi-has-a-new-home>); the runtime dep
  switches from `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent`
  (and `@mariozechner/pi-ai` → `@earendil-works/pi-ai`). New floor is
  `0.74.0`, the first release on the new scope. No wire shape, protocol
  version, or public API change — this package's own exports are
  unaffected; reinstall picks up the new transitive graph
  (`pi-agent-core`, `pi-ai`, `pi-tui` all on the new scope). The old
  `@mariozechner/*` packages are deprecated but remain published for
  reproducibility.

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
  flip from `pi` to `pi-headless` for both the controller and its
  spawned sessions. This separates the headless example from the
  standalone `agents/pi/` runtime (which keeps `pi`).
- **Metadata simplification.** `metadata.role = "pi-headless-controller"`
  becomes `metadata.role = "controller"`; sessions now carry
  `metadata.role = "session"`. The redundant `metadata.spawner` field
  is dropped — the `agent` token already disambiguates.
- **Default controller name** flips from `exec` to `control`. On
  startup the controller probes `$SRV.INFO.agents` and picks the next
  free `<name>-N` if its target prompt subject is already claimed, so
  two pi-headless processes booted with default settings yield
  `control` and `control-2` automatically.

### Subject migration

| from | to |
| --- | --- |
| `agents.prompt.pi.<owner>.<name>` | `agents.prompt.pi-headless.<owner>.<name>` |
| `agents.hb.pi.<owner>.<name>` | `agents.hb.pi-headless.<owner>.<name>` |
| `agents.status.pi.<owner>.<name>` | `agents.status.pi-headless.<owner>.<name>` |
| `agents.pi.<owner>.<name>.spawn` | `agents.spawn.pi-headless.<owner>.<name>` |
| `agents.pi.<owner>.<name>.stop` | `agents.stop.pi-headless.<owner>.<name>` |
| `agents.pi.<owner>.<name>.list` | `agents.list.pi-headless.<owner>.<name>` |
| `agents.prompt.pi.<owner>.<session_id>` | `agents.prompt.pi-headless.<owner>.<session_id>` |
| `agents.hb.pi.<owner>.<session_id>` | `agents.hb.pi-headless.<owner>.<session_id>` |
| `agents.status.pi.<owner>.<session_id>` | `agents.status.pi-headless.<owner>.<session_id>` |

### SDK

Bumps `@synadia-ai/agents` and `@synadia-ai/agent-service` pins to
`^0.5.0`.
